import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import type { StateError } from "../errors.ts";
import { stateSql } from "../sql.ts";
import type { WebMessage } from "./types.ts";

const Row = Schema.Struct({
  id: Schema.Finite,
  role: Schema.String,
  text: Schema.String,
  at: Schema.Finite,
});

const toMessage = (row: typeof Row.Type): WebMessage => ({
  id: row.id,
  role: row.role === "agent" ? "agent" : "user",
  text: row.text,
  at: row.at,
});

const MAX_MESSAGES = 200;

/**
 * The legacy web transcript. New web messages live in the web chat source, so
 * this table is read once during the source's first initialization.
 */
export class WebThreads extends Context.Service<
  WebThreads,
  {
    messages(
      place: string,
      after: number,
      limit?: number,
    ): Effect.Effect<ReadonlyArray<WebMessage>, StateError>;
  }
>()("mizook/WebThreads") {
  static readonly layer = (sql: SqlDriver) =>
    Layer.effect(
      WebThreads,
      Effect.gen(function* () {
        const { run, rows } = stateSql(sql);

        yield* run("migrate web messages", async () => {
          await sql.all(
            `CREATE TABLE IF NOT EXISTS web_messages (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               place TEXT NOT NULL,
               role TEXT NOT NULL,
               text TEXT NOT NULL,
               at INTEGER NOT NULL)`,
          );
          await sql.all(
            `CREATE INDEX IF NOT EXISTS web_messages_place ON web_messages (place, id)`,
          );
        });

        return WebThreads.of({
          messages: (place, after, limit = MAX_MESSAGES) =>
            rows(Row)(
              "web messages",
              `SELECT id, role, text, at FROM web_messages
               WHERE place = ? AND id > ? ORDER BY id ASC LIMIT ?`,
              place,
              Math.max(after, 0),
              Math.min(Math.max(limit, 1), MAX_MESSAGES),
            ).pipe(Effect.map((found) => found.map(toMessage))),
        });
      }),
    );
}
