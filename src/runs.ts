import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { StateError } from "./errors.ts";

export type RunStatus = "running" | "succeeded" | "failed" | "skipped";

export interface Run {
  readonly id: number;
  readonly scheduleId: number;
  readonly started: number;
  readonly finished: number | undefined;
  readonly status: RunStatus;
  readonly output: string;
  readonly error: string | undefined;
}

const Row = Schema.Struct({
  id: Schema.Finite,
  schedule_id: Schema.Finite,
  started: Schema.Finite,
  finished: Schema.NullOr(Schema.Finite),
  status: Schema.Literals(["running", "succeeded", "failed", "skipped"]),
  output: Schema.String,
  error: Schema.NullOr(Schema.String),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const toRun = (row: typeof Row.Type): Run => ({
  id: row.id,
  scheduleId: row.schedule_id,
  started: row.started,
  finished: row.finished ?? undefined,
  status: row.status,
  output: row.output,
  error: row.error ?? undefined,
});

const SELECT = `SELECT id, schedule_id, started, finished, status, output, error FROM app_runs`;

/** A schedule's runs: enough to tell a working routine from one that keeps failing. */
export class Runs extends Context.Service<
  Runs,
  {
    start(scheduleId: number): Effect.Effect<number, StateError>;
    finish(
      id: number,
      status: Exclude<RunStatus, "running">,
      output?: string,
      error?: string,
    ): Effect.Effect<void, StateError>;
    list(options: {
      readonly limit: number;
      readonly scheduleId?: number;
    }): Effect.Effect<ReadonlyArray<Run>, StateError>;
  }
>()("mizook/Runs") {
  static readonly layer = (sql: SqlDriver) =>
    Layer.effect(
      Runs,
      Effect.gen(function* () {
        const run = <A>(operation: string, f: () => A | Promise<A>) =>
          Effect.tryPromise({
            try: async () => f(),
            catch: (cause) => new StateError({ operation, cause }),
          });

        yield* run("migrate runs", async () => {
          await sql.all(
            `CREATE TABLE IF NOT EXISTS app_runs (
               id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER NOT NULL,
               started INTEGER NOT NULL, finished INTEGER, status TEXT NOT NULL,
               output TEXT NOT NULL DEFAULT '', error TEXT)`,
          );
          // Keep the table bounded; a run older than ninety days is not worth a row.
          await sql.all(`DELETE FROM app_runs WHERE started < ?`, Date.now() - 90 * 86_400_000);
        });

        const query = (operation: string, text: string, ...params: unknown[]) =>
          run(operation, () => sql.all(text, ...params)).pipe(
            Effect.flatMap(decodeRows),
            Effect.mapError((cause) =>
              cause instanceof StateError ? cause : new StateError({ operation, cause }),
            ),
            Effect.map((rows) => rows.map(toRun)),
          );

        return Runs.of({
          start: (scheduleId) =>
            query(
              "start run",
              `INSERT INTO app_runs (schedule_id, started, status) VALUES (?, ?, 'running')
               RETURNING id, schedule_id, started, finished, status, output, error`,
              scheduleId,
              Date.now(),
            ).pipe(Effect.map((rows) => rows[0]!.id)),
          finish: (id, status, output, error) =>
            run("finish run", () =>
              sql.all(
                `UPDATE app_runs SET finished = ?, status = ?, output = ?, error = ? WHERE id = ?`,
                Date.now(),
                status,
                output ?? "",
                error ?? null,
                id,
              ),
            ).pipe(Effect.asVoid),
          list: ({ limit, scheduleId }) =>
            query(
              "list runs",
              scheduleId === undefined
                ? `${SELECT} ORDER BY id DESC LIMIT ?`
                : `${SELECT} WHERE schedule_id = ? ORDER BY id DESC LIMIT ?`,
              ...(scheduleId === undefined ? [limit] : [scheduleId, limit]),
            ),
        });
      }),
    );
}
