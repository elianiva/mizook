import type { SqlDriver } from "@mizook/memory/sqlite";
import { Effect, Schema } from "effect";
import { StateError } from "./errors.ts";

/** Runs one SQL driver call as an Effect that fails with a `StateError`, and decodes row sets. */
export const stateSql = (sql: SqlDriver) => {
  const run = <A>(operation: string, f: () => A | Promise<A>) =>
    Effect.tryPromise({
      try: async () => f(),
      catch: (cause) => new StateError({ operation, cause }),
    });

  const rows = <S extends Schema.Decoder<unknown>>(row: S) => {
    const decode = Schema.decodeUnknownEffect(Schema.Array(row));
    return (operation: string, text: string, ...params: unknown[]) =>
      run(operation, () => sql.all(text, ...params)).pipe(
        Effect.flatMap(decode),
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(new StateError({ operation, cause })),
        ),
      );
  };

  return { run, rows };
};
