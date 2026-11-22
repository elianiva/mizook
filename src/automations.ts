import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { ScheduleError, StateError } from "./errors.ts";
import {
  ActionJson,
  firstFire,
  nextFire,
  NEVER,
  SpecJson,
  type Action,
  type Spec,
} from "./schedule.ts";

type EpochMsOrNever = number;

export interface Automation {
  readonly id: number;
  readonly spec: Spec;
  readonly action: Action;
  readonly nextAt: EpochMsOrNever;
  readonly active: boolean;
  readonly lastHash: string | undefined;
}

const Row = Schema.Struct({
  id: Schema.Finite,
  spec: SpecJson,
  action: ActionJson,
  next_at: Schema.Finite,
  active: Schema.Finite,
  last_hash: Schema.NullOr(Schema.String),
});

const toAutomation = (row: typeof Row.Type): Automation => ({
  id: row.id,
  spec: row.spec,
  action: row.action,
  nextAt: row.next_at,
  active: row.active === 1,
  lastHash: row.last_hash ?? undefined,
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const HOUR = 3_600_000;

const firesByClock = (a: Automation) => a.nextAt < NEVER;

export class Automations extends Context.Service<
  Automations,
  {
    create(
      spec: Spec,
      action: Action,
      now: Date,
    ): Effect.Effect<Automation, ScheduleError | StateError>;
    readonly list: Effect.Effect<ReadonlyArray<Automation>, StateError>;
    readonly all: Effect.Effect<ReadonlyArray<Automation>, StateError>;
    get(id: number): Effect.Effect<Automation | undefined, StateError>;
    cancel(id: number): Effect.Effect<boolean, StateError>;
    pause(id: number): Effect.Effect<boolean, StateError>;
    resume(id: number, now: Date): Effect.Effect<boolean, ScheduleError | StateError>;
    claim(now: Date): Effect.Effect<ReadonlyArray<Automation>, StateError>;
    watchChanged(id: number, hash: string): Effect.Effect<boolean, StateError>;
    allow(now: Date, limit: number, key: string): Effect.Effect<boolean, StateError>;
    readonly nextAt: Effect.Effect<number | undefined, StateError>;
  }
>()("mizook/Automations") {
  static readonly layer = (
    sql: SqlDriver,
    moveAlarmEarlierTo: (at: number) => Promise<void> = async () => {},
  ) =>
    Layer.effect(
      Automations,
      Effect.gen(function* () {
        const run = <A>(operation: string, f: () => A | Promise<A>) =>
          Effect.tryPromise({
            try: async () => f(),
            catch: (cause) => new StateError({ operation, cause }),
          });

        yield* run("migrate automations", async () => {
          await sql.all(
            `CREATE TABLE IF NOT EXISTS app_automations (
               id INTEGER PRIMARY KEY AUTOINCREMENT, spec TEXT NOT NULL, action TEXT NOT NULL,
               next_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
               created INTEGER NOT NULL, last_hash TEXT)`,
          );
          await sql.all(
            `CREATE TABLE IF NOT EXISTS app_fires (at INTEGER NOT NULL, key TEXT NOT NULL)`,
          );
        });

        const oneWakeAtATime = (yield* Semaphore.make(1)).withPermits(1);

        const query = (operation: string, text: string, ...params: unknown[]) =>
          run(operation, () => sql.all(text, ...params)).pipe(
            Effect.flatMap(decodeRows),
            Effect.mapError((cause) =>
              cause instanceof StateError ? cause : new StateError({ operation, cause }),
            ),
            Effect.map((rows) => rows.map(toAutomation)),
          );
        const all = query(
          "all automations",
          `SELECT id, spec, action, next_at, active, last_hash FROM app_automations ORDER BY id`,
        );
        const active = query(
          "active automations",
          `SELECT id, spec, action, next_at, active, last_hash FROM app_automations WHERE active = 1 ORDER BY next_at, id`,
        );

        return Automations.of({
          create: (spec, action, now) =>
            Effect.gen(function* () {
              const at = (yield* firstFire(spec, now)).getTime();
              const [made] = yield* query(
                "create automation",
                `INSERT INTO app_automations (spec, action, next_at, created) VALUES (?, ?, ?, ?)
                 RETURNING id, spec, action, next_at, active, last_hash`,
                yield* Schema.encodeEffect(SpecJson)(spec).pipe(
                  Effect.mapError((cause) => new StateError({ operation: "encode spec", cause })),
                ),
                yield* Schema.encodeEffect(ActionJson)(action).pipe(
                  Effect.mapError((cause) => new StateError({ operation: "encode action", cause })),
                ),
                at,
                now.getTime(),
              );
              yield* run("arm", () => moveAlarmEarlierTo(at));
              return made!;
            }),
          list: active,
          all,
          get: (id) =>
            query(
              "get automation",
              `SELECT id, spec, action, next_at, active, last_hash FROM app_automations WHERE id = ?`,
              id,
            ).pipe(Effect.map((rows) => rows[0])),
          cancel: (id) =>
            run("cancel automation", () =>
              sql.all(`DELETE FROM app_automations WHERE id = ? RETURNING id`, id),
            ).pipe(Effect.map((rows) => rows.length > 0)),
          pause: (id) =>
            run("pause automation", () =>
              sql.all(
                `UPDATE app_automations SET active = 0 WHERE id = ? AND active = 1 RETURNING id`,
                id,
              ),
            ).pipe(Effect.map((rows) => rows.length > 0)),
          resume: (id, now) =>
            Effect.gen(function* () {
              const found = yield* query(
                "resume automation",
                `SELECT id, spec, action, next_at, active, last_hash FROM app_automations WHERE id = ?`,
                id,
              ).pipe(Effect.map((rows) => rows[0]));
              if (!found) return false;
              const next = yield* nextFire(found.spec, now);
              if (!next) {
                return yield* new ScheduleError({
                  reason: `automation #${id} has no next time; create a new one`,
                });
              }
              yield* run("resume automation", () =>
                sql.all(
                  `UPDATE app_automations SET active = 1, next_at = ? WHERE id = ?`,
                  next.getTime(),
                  id,
                ),
              );
              yield* run("arm", () => moveAlarmEarlierTo(next.getTime()));
              return true;
            }),
          claim: (now) =>
            oneWakeAtATime(
              Effect.gen(function* () {
                const due = (yield* active).filter((s) => s.nextAt <= now.getTime());
                for (const s of due) {
                  const nextSlot = yield* nextFire(s.spec, now).pipe(
                    Effect.orElseSucceed(() => undefined),
                  );
                  yield* run("advance automation", () =>
                    nextSlot
                      ? sql.all(
                          `UPDATE app_automations SET next_at = ? WHERE id = ?`,
                          nextSlot.getTime(),
                          s.id,
                        )
                      : sql.all(`UPDATE app_automations SET active = 0 WHERE id = ?`, s.id),
                  );
                }
                return due;
              }),
            ),
          watchChanged: (id, hash) =>
            run("watch", async () => {
              const row = (
                await sql.all<{ last_hash: string | null }>(
                  `SELECT last_hash FROM app_automations WHERE id = ?`,
                  id,
                )
              )[0];
              await sql.all(`UPDATE app_automations SET last_hash = ? WHERE id = ?`, hash, id);
              return row?.last_hash != null && row.last_hash !== hash;
            }),
          allow: (now, limit, key) =>
            run("rate limit", async () => {
              await sql.all(`DELETE FROM app_fires WHERE at < ?`, now.getTime() - HOUR);
              const count =
                (
                  await sql.all<{ n: number }>(
                    `SELECT COUNT(*) AS n FROM app_fires WHERE key = ?`,
                    key,
                  )
                )[0]?.n ?? 0;
              if (count >= limit) return false;
              await sql.all(`INSERT INTO app_fires (at, key) VALUES (?, ?)`, now.getTime(), key);
              return true;
            }),
          nextAt: Effect.map(active, (all) => all.find(firesByClock)?.nextAt),
        });
      }),
    );
}
