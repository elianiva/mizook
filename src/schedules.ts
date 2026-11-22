import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { ScheduleError, StateError } from "./errors.ts";
import { firstFire, nextFire, SpecJson, type Spec } from "./schedule.ts";

export interface Schedule {
  readonly id: number;
  readonly spec: Spec;
  /** What the agent is told when it fires. */
  readonly prompt: string;
  /** A skill to read before the prompt, by name. */
  readonly skill: string | undefined;
  /** Epoch milliseconds of the next fire. */
  readonly nextAt: number;
  /** A paused schedule stays in the table but does not fire. */
  readonly active: boolean;
  /** For a watch: a hash of what it saw last. */
  readonly lastHash: string | undefined;
  /** Where its turn talks: the place it was created in. Empty: wherever the agent talked last. */
  readonly place: string;
}

const Row = Schema.Struct({
  id: Schema.Finite,
  spec: SpecJson,
  prompt: Schema.String,
  skill: Schema.NullOr(Schema.String),
  next_at: Schema.Finite,
  active: Schema.Finite,
  last_hash: Schema.NullOr(Schema.String),
  place: Schema.String,
});

const toSchedule = (row: typeof Row.Type): Schedule => ({
  id: row.id,
  spec: row.spec,
  prompt: row.prompt,
  skill: row.skill ?? undefined,
  nextAt: row.next_at,
  active: row.active === 1,
  lastHash: row.last_hash ?? undefined,
  place: row.place,
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const HOUR = 3_600_000;

/**
 * What wakes the chat: one-off reminders, crons, and watches, in the chat's own SQLite so they
 * move with an export. Tables are prefixed `app_`.
 */
export class Schedules extends Context.Service<
  Schedules,
  {
    create(
      spec: Spec,
      prompt: string,
      now: Date,
      skill?: string,
      place?: string,
    ): Effect.Effect<Schedule, ScheduleError | StateError>;
    /** Active schedules only, soonest first. */
    readonly list: Effect.Effect<ReadonlyArray<Schedule>, StateError>;
    /** Every schedule, active and paused, for management. */
    readonly all: Effect.Effect<ReadonlyArray<Schedule>, StateError>;
    get(id: number): Effect.Effect<Schedule | undefined, StateError>;
    cancel(id: number): Effect.Effect<boolean, StateError>;
    pause(id: number): Effect.Effect<boolean, StateError>;
    /** Start a paused schedule again, from its next time after `now`. */
    resume(id: number, now: Date): Effect.Effect<boolean, ScheduleError | StateError>;
    /**
     * Take the schedules due at `now` and move each to its next time, in one step. A cron missed
     * during downtime is returned once. A `once` is finished. At most once: a crash after this and
     * before the turn starts loses that fire.
     */
    claim(now: Date): Effect.Effect<ReadonlyArray<Schedule>, StateError>;
    /** Remember what a watch saw. True when it differs from last time (never on the first look). */
    watchChanged(id: number, hash: string): Effect.Effect<boolean, StateError>;
    /** Count a fire against the hourly limit. False when the chat has fired `limit` times in the last hour. */
    allow(now: Date, limit: number): Effect.Effect<boolean, StateError>;
    /** The earliest time anything is due, in epoch milliseconds. */
    readonly nextAt: Effect.Effect<number | undefined, StateError>;
  }
>()("mizook/Schedules") {
  /**
   * `arm(at)` is told when a new schedule is due, so the Durable Object can move its alarm
   * earlier. It never moves it later: the alarm handler sets the exact time after each wake.
   */
  static readonly layer = (sql: SqlDriver, arm: (at: number) => Promise<void> = async () => {}) =>
    Layer.effect(
      Schedules,
      Effect.gen(function* () {
        const run = <A>(operation: string, f: () => A | Promise<A>) =>
          Effect.tryPromise({
            try: async () => f(),
            catch: (cause) => new StateError({ operation, cause }),
          });

        yield* run("migrate schedules", async () => {
          await sql.all(
            `CREATE TABLE IF NOT EXISTS app_schedules (
               id INTEGER PRIMARY KEY AUTOINCREMENT, spec TEXT NOT NULL, prompt TEXT NOT NULL,
               next_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
               created INTEGER NOT NULL, last_hash TEXT, skill TEXT,
               place TEXT NOT NULL DEFAULT '')`,
          );
          const columns = await sql.all<{ name: string }>(`PRAGMA table_info(app_schedules)`);
          if (!columns.some((column) => column.name === "skill")) {
            await sql.all(`ALTER TABLE app_schedules ADD COLUMN skill TEXT`);
          }
          await sql.all(`CREATE TABLE IF NOT EXISTS app_fires (at INTEGER NOT NULL)`);
        });

        // Two wakes must not take the same due schedule: the reads and writes below interleave.
        const lock = (yield* Semaphore.make(1)).withPermits(1);

        /** Rows come back as plain objects; the schema makes them schedules or a StateError. */
        const query = (operation: string, text: string, ...params: unknown[]) =>
          run(operation, () => sql.all(text, ...params)).pipe(
            Effect.flatMap(decodeRows),
            Effect.mapError((cause) =>
              cause instanceof StateError ? cause : new StateError({ operation, cause }),
            ),
            Effect.map((rows) => rows.map(toSchedule)),
          );
        const all = query(
          "all schedules",
          `SELECT id, spec, prompt, skill, next_at, active, last_hash, place FROM app_schedules ORDER BY id`,
        );
        const active = query(
          "active schedules",
          `SELECT id, spec, prompt, skill, next_at, active, last_hash, place FROM app_schedules WHERE active = 1 ORDER BY next_at, id`,
        );

        return Schedules.of({
          create: (spec, prompt, now, skill, place) =>
            Effect.gen(function* () {
              const at = (yield* firstFire(spec, now)).getTime();
              const [made] = yield* query(
                "create schedule",
                `INSERT INTO app_schedules (spec, prompt, skill, next_at, created, place) VALUES (?, ?, ?, ?, ?, ?)
                 RETURNING id, spec, prompt, skill, next_at, active, last_hash, place`,
                yield* Schema.encodeEffect(SpecJson)(spec).pipe(
                  Effect.mapError((cause) => new StateError({ operation: "encode spec", cause })),
                ),
                prompt,
                skill ?? null,
                at,
                now.getTime(),
                place ?? "",
              );
              yield* run("arm", () => arm(at));
              return made!;
            }),
          list: active,
          all,
          get: (id) =>
            query(
              "get schedule",
              `SELECT id, spec, prompt, skill, next_at, active, last_hash, place FROM app_schedules WHERE id = ?`,
              id,
            ).pipe(Effect.map((rows) => rows[0])),
          cancel: (id) =>
            run("cancel schedule", () =>
              sql.all(`DELETE FROM app_schedules WHERE id = ? RETURNING id`, id),
            ).pipe(Effect.map((rows) => rows.length > 0)),
          pause: (id) =>
            run("pause schedule", () =>
              sql.all(
                `UPDATE app_schedules SET active = 0 WHERE id = ? AND active = 1 RETURNING id`,
                id,
              ),
            ).pipe(Effect.map((rows) => rows.length > 0)),
          resume: (id, now) =>
            Effect.gen(function* () {
              const found = yield* query(
                "resume schedule",
                `SELECT id, spec, prompt, skill, next_at, active, last_hash, place FROM app_schedules WHERE id = ?`,
                id,
              ).pipe(Effect.map((rows) => rows[0]));
              if (!found) return false;
              const next = yield* nextFire(found.spec, now);
              if (!next) {
                return yield* new ScheduleError({
                  reason: `schedule #${id} has no next time; create a new one`,
                });
              }
              yield* run("resume schedule", () =>
                sql.all(
                  `UPDATE app_schedules SET active = 1, next_at = ? WHERE id = ?`,
                  next.getTime(),
                  id,
                ),
              );
              yield* run("arm", () => arm(next.getTime()));
              return true;
            }),
          claim: (now) =>
            lock(
              Effect.gen(function* () {
                const due = (yield* active).filter((s) => s.nextAt <= now.getTime());
                for (const s of due) {
                  // Always the next time after now: a cron that missed several slots fires once.
                  const next = yield* nextFire(s.spec, now).pipe(
                    Effect.orElseSucceed(() => undefined),
                  );
                  yield* run("advance schedule", () =>
                    next
                      ? sql.all(
                          `UPDATE app_schedules SET next_at = ? WHERE id = ?`,
                          next.getTime(),
                          s.id,
                        )
                      : sql.all(`UPDATE app_schedules SET active = 0 WHERE id = ?`, s.id),
                  );
                }
                return due;
              }),
            ),
          watchChanged: (id, hash) =>
            run("watch", async () => {
              const row = (
                await sql.all<{ last_hash: string | null }>(
                  `SELECT last_hash FROM app_schedules WHERE id = ?`,
                  id,
                )
              )[0];
              await sql.all(`UPDATE app_schedules SET last_hash = ? WHERE id = ?`, hash, id);
              return row?.last_hash != null && row.last_hash !== hash;
            }),
          allow: (now, limit) =>
            run("rate limit", async () => {
              await sql.all(`DELETE FROM app_fires WHERE at < ?`, now.getTime() - HOUR);
              const count =
                (await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM app_fires`))[0]?.n ?? 0;
              if (count >= limit) return false;
              await sql.all(`INSERT INTO app_fires (at) VALUES (?)`, now.getTime());
              return true;
            }),
          nextAt: Effect.map(active, (all) => all[0]?.nextAt),
        });
      }),
    );
}
