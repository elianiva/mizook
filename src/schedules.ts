import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Semaphore } from "effect";
import { ScheduleError, StateError } from "./errors.ts";
import { invalid, nextFire, type Spec } from "./schedule.ts";

export interface Schedule {
  readonly id: number;
  readonly spec: Spec;
  /** What the agent is told when it fires. */
  readonly prompt: string;
  /** Epoch milliseconds of the next fire. */
  readonly nextAt: number;
  /** For a watch: a hash of what it saw last. */
  readonly lastHash: string | undefined;
}

interface Row {
  id: number;
  spec: string;
  prompt: string;
  next_at: number;
  last_hash: string | null;
}

const toSchedule = (row: Row): Schedule => ({
  id: row.id,
  spec: JSON.parse(row.spec) as Spec,
  prompt: row.prompt,
  nextAt: row.next_at,
  lastHash: row.last_hash ?? undefined,
});

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
    ): Effect.Effect<Schedule, ScheduleError | StateError>;
    readonly list: Effect.Effect<ReadonlyArray<Schedule>, StateError>;
    cancel(id: number): Effect.Effect<boolean, StateError>;
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
               created INTEGER NOT NULL, last_hash TEXT)`,
          );
          await sql.all(`CREATE TABLE IF NOT EXISTS app_fires (at INTEGER NOT NULL)`);
        });

        // Two wakes must not take the same due schedule: the reads and writes below interleave.
        const lock = (yield* Semaphore.make(1)).withPermits(1);

        const active = () =>
          sql.all<Row>(
            `SELECT id, spec, prompt, next_at, last_hash FROM app_schedules WHERE active = 1 ORDER BY next_at, id`,
          );

        return Schedules.of({
          create: (spec, prompt, now) =>
            Effect.gen(function* () {
              const problem = invalid(spec, now);
              if (problem) return yield* new ScheduleError({ reason: problem });
              const at = nextFire(spec, now)!.getTime();
              const rows = yield* run("create schedule", () =>
                sql.all<Row>(
                  `INSERT INTO app_schedules (spec, prompt, next_at, created) VALUES (?, ?, ?, ?)
                   RETURNING id, spec, prompt, next_at, last_hash`,
                  JSON.stringify(spec),
                  prompt,
                  at,
                  now.getTime(),
                ),
              );
              yield* run("arm", () => arm(at));
              return toSchedule(rows[0]!);
            }),
          list: run("list schedules", async () => (await active()).map(toSchedule)),
          cancel: (id) =>
            run("cancel schedule", async () => {
              const rows = await sql.all(
                `UPDATE app_schedules SET active = 0 WHERE id = ? AND active = 1 RETURNING id`,
                id,
              );
              return rows.length > 0;
            }),
          claim: (now) =>
            lock(
              run("claim schedules", async () => {
                const due = (await active())
                  .map(toSchedule)
                  .filter((s) => s.nextAt <= now.getTime());
                for (const s of due) {
                  // Always the next time after now: a cron that missed several slots fires once.
                  const next = nextFire(s.spec, now);
                  if (next) {
                    await sql.all(
                      `UPDATE app_schedules SET next_at = ? WHERE id = ?`,
                      next.getTime(),
                      s.id,
                    );
                  } else {
                    await sql.all(`UPDATE app_schedules SET active = 0 WHERE id = ?`, s.id);
                  }
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
          nextAt: run("next wake", async () => (await active())[0]?.next_at),
        });
      }),
    );
}
