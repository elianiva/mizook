import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { StateError } from "./errors.ts";

/** One SQLite connection: runs a statement and returns its rows. */
export interface SqlDriver {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] | Promise<T[]>;
}

/**
 * One schema change. A step that a database may already have, because it ran before migrations
 * were recorded, names the error that means so, and that error counts as applied.
 */
export type MigrationStep = string | { readonly sql: string; readonly tolerate: string };

const errorMentions = (cause: unknown, text: string) =>
  (cause instanceof Error ? cause.message : String(cause)).includes(text);

export class Sql extends Context.Service<
  Sql,
  {
    /** Runs one statement and returns its rows as they come. */
    exec<T = Record<string, unknown>>(
      operation: string,
      text: string,
      ...params: unknown[]
    ): Effect.Effect<ReadonlyArray<T>, StateError>;
    /** Runs one statement and decodes each row. */
    rows<S extends Schema.Decoder<unknown>>(
      row: S,
    ): (
      operation: string,
      text: string,
      ...params: unknown[]
    ) => Effect.Effect<ReadonlyArray<S["Type"]>, StateError>;
    /**
     * Runs the steps of one named migration that have not run yet, in order, recording each in
     * `_migrations`. Steps are only ever appended: never edit or remove one that has shipped.
     */
    migrate(name: string, steps: ReadonlyArray<MigrationStep>): Effect.Effect<void, StateError>;
  }
>()("mizook/Sql") {
  static readonly layer = (driver: SqlDriver) =>
    Layer.effect(
      Sql,
      Effect.gen(function* () {
        const exec = <T = Record<string, unknown>>(
          operation: string,
          text: string,
          ...params: unknown[]
        ) =>
          Effect.tryPromise({
            try: async (): Promise<ReadonlyArray<T>> => driver.all<T>(text, ...params),
            catch: (cause) => new StateError({ operation, cause }),
          });

        const rows =
          <S extends Schema.Decoder<unknown>>(row: S) =>
          (operation: string, text: string, ...params: unknown[]) =>
            exec(operation, text, ...params).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(row))),
              Effect.catchTag("SchemaError", (cause) =>
                Effect.fail(new StateError({ operation, cause })),
              ),
            );

        yield* exec(
          "migrate",
          `CREATE TABLE IF NOT EXISTS _migrations (
             name TEXT NOT NULL, step INTEGER NOT NULL, applied_at INTEGER NOT NULL,
             PRIMARY KEY (name, step))`,
        );
        const oneMigrationAtATime = (yield* Semaphore.make(1)).withPermits(1);

        const migrate = (name: string, steps: ReadonlyArray<MigrationStep>) =>
          oneMigrationAtATime(
            Effect.gen(function* () {
              const operation = `migrate ${name}`;
              const applied = new Set(
                (yield* exec<{ step: number }>(
                  operation,
                  `SELECT step FROM _migrations WHERE name = ?`,
                  name,
                )).map((row) => row.step),
              );
              for (const [index, step] of steps.entries()) {
                if (applied.has(index)) continue;
                yield* typeof step === "string"
                  ? exec(operation, step)
                  : exec(operation, step.sql).pipe(
                      Effect.catchIf(
                        (error) => errorMentions(error.cause, step.tolerate),
                        () => Effect.succeed([]),
                      ),
                    );
                yield* exec(
                  operation,
                  `INSERT INTO _migrations (name, step, applied_at) VALUES (?, ?, ?)`,
                  name,
                  index,
                  Date.now(),
                );
              }
            }),
          );

        return Sql.of({ exec, rows, migrate });
      }),
    );
}
