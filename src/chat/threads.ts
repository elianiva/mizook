import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { StateError } from "../errors.ts";
import { Host } from "../host.ts";
import type { WebMessage, WebMessageRole } from "./types.ts";

const Row = Schema.Struct({
  id: Schema.Finite,
  role: Schema.String,
  text: Schema.String,
  at: Schema.Finite,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const toMessage = (row: typeof Row.Type): WebMessage => ({
  id: row.id,
  role: row.role === "agent" ? "agent" : "user",
  text: row.text,
  at: row.at,
});

const MAX_MESSAGES = 200;
const PREVIEW_CHARS = 160;

/**
 * The web transcript is a projection of what the agent said in a place, not
 * the agent's memory. The memory is shared by every place, and agent bubbles
 * are not tagged with one, so the log cannot reconstruct a thread.
 */
export class WebThreads extends Context.Service<
  WebThreads,
  {
    append(
      place: string,
      role: WebMessageRole,
      text: string,
    ): Effect.Effect<WebMessage, StateError>;
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
        const host = yield* Host;
        const run = <A>(operation: string, f: () => A | Promise<A>) =>
          Effect.tryPromise({
            try: async () => f(),
            catch: (cause) => new StateError({ operation, cause }),
          });

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
          append: (place, role, text) =>
            Effect.gen(function* () {
              const at = Date.now();
              const rows = yield* run("append web message", () =>
                sql.all(
                  `INSERT INTO web_messages (place, role, text, at) VALUES (?, ?, ?, ?)
                   RETURNING id, role, text, at`,
                  place,
                  role,
                  text,
                  at,
                ),
              );
              const message = yield* decodeRows(rows).pipe(
                Effect.mapError(
                  (cause) => new StateError({ operation: "append web message", cause }),
                ),
              );
              const found = message[0];
              if (!found) {
                return yield* new StateError({
                  operation: "append web message",
                  cause: "the insert returned no row",
                });
              }
              yield* host
                .touchWebThread(place, previewOf(text))
                .pipe(
                  Effect.catchCause((cause) => Effect.logWarning("thread preview failed", cause)),
                );
              return toMessage(found);
            }),
          messages: (place, after, limit = MAX_MESSAGES) =>
            run("web messages", () =>
              sql.all(
                `SELECT id, role, text, at FROM web_messages
                 WHERE place = ? AND id > ? ORDER BY id ASC LIMIT ?`,
                place,
                Math.max(after, 0),
                Math.min(Math.max(limit, 1), MAX_MESSAGES),
              ),
            ).pipe(
              Effect.flatMap(decodeRows),
              Effect.mapError((cause) =>
                cause instanceof StateError
                  ? cause
                  : new StateError({ operation: "web messages", cause }),
              ),
              Effect.map((rows) => rows.map(toMessage)),
            ),
        });
      }),
    );
}

const previewOf = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
