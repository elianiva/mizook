import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { StateError } from "./errors.ts";

const DAY_MS = 86_400_000;
const RUN_RETENTION_MS = 90 * DAY_MS;

export type RunStatus = "running" | "succeeded" | "failed" | "skipped";

export interface Run {
  readonly id: number;
  readonly automationId: number;
  readonly started: number;
  readonly finished: number | undefined;
  readonly status: RunStatus;
  readonly output: string;
  readonly error: string | undefined;
}

const Row = Schema.Struct({
  id: Schema.Finite,
  automation_id: Schema.Finite,
  started: Schema.Finite,
  finished: Schema.NullOr(Schema.Finite),
  status: Schema.Literals(["running", "succeeded", "failed", "skipped"]),
  output: Schema.String,
  error: Schema.NullOr(Schema.String),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const toRun = (row: typeof Row.Type): Run => ({
  id: row.id,
  automationId: row.automation_id,
  started: row.started,
  finished: row.finished ?? undefined,
  status: row.status,
  output: row.output,
  error: row.error ?? undefined,
});

const SELECT = `SELECT id, automation_id, started, finished, status, output, error FROM app_runs`;

export class Runs extends Context.Service<
  Runs,
  {
    start(automationId: number): Effect.Effect<number, StateError>;
    finish(
      id: number,
      status: Exclude<RunStatus, "running">,
      output?: string,
      error?: string,
    ): Effect.Effect<void, StateError>;
    list(options: {
      readonly limit: number;
      readonly automationId?: number;
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
               id INTEGER PRIMARY KEY AUTOINCREMENT, automation_id INTEGER NOT NULL,
               started INTEGER NOT NULL, finished INTEGER, status TEXT NOT NULL,
               output TEXT NOT NULL DEFAULT '', error TEXT)`,
          );
          await sql.all(`DELETE FROM app_runs WHERE started < ?`, Date.now() - RUN_RETENTION_MS);
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
          start: (automationId) =>
            query(
              "start run",
              `INSERT INTO app_runs (automation_id, started, status) VALUES (?, ?, 'running')
               RETURNING id, automation_id, started, finished, status, output, error`,
              automationId,
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
          list: ({ limit, automationId }) =>
            query(
              "list runs",
              automationId === undefined
                ? `${SELECT} ORDER BY id DESC LIMIT ?`
                : `${SELECT} WHERE automation_id = ? ORDER BY id DESC LIMIT ?`,
              ...(automationId === undefined ? [limit] : [automationId, limit]),
            ),
        });
      }),
    );
}
