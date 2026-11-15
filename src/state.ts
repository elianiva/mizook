import { Context, Effect, Layer, Schema } from "effect";
import type { SqlDriver } from "@mizook/memory/sqlite";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { StateError } from "./errors.ts";

/** A turn the agent is working on for one chat, kept until its reply is delivered. */
export interface PendingTurn {
  readonly chatId: string;
  /** Where to post the reply: a Chat SDK thread id. */
  readonly threadId: string;
  readonly conversationId: ConversationId;
  /** The Telegram message that started the turn. Resubmitting with it finds the same submission. */
  readonly requestId: string;
  readonly text: string;
  /** The first, then every message the user sent while it ran. */
  readonly submissions: ReadonlyArray<SubmissionId>;
  /** The transcript is in the memory. */
  readonly logged: boolean;
}

const Row = Schema.Struct({
  chat_id: Schema.String,
  thread_id: Schema.String,
  conversation_id: Schema.Finite,
  request_id: Schema.String,
  text: Schema.String,
  submissions: Schema.fromJsonString(Schema.Array(Schema.Finite)),
  logged: Schema.Finite,
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

// pi-durable's ids are branded numbers: the brand is the only cast, at the storage boundary.
const toTurn = (row: typeof Row.Type): PendingTurn => ({
  chatId: row.chat_id,
  threadId: row.thread_id,
  conversationId: row.conversation_id as ConversationId,
  requestId: row.request_id,
  text: row.text,
  submissions: row.submissions as SubmissionId[],
  logged: row.logged === 1,
});

const asStateError = (operation: string) => (cause: unknown) =>
  cause instanceof StateError ? cause : new StateError({ operation, cause });

const WEEK = 7 * 24 * 3600 * 1000;

/** The bot's bookkeeping, in the same SQLite as the log. Tables are prefixed `app_`. */
export class State extends Context.Service<
  State,
  {
    turn(chatId: string): Effect.Effect<PendingTurn | undefined, StateError>;
    readonly turns: Effect.Effect<ReadonlyArray<PendingTurn>, StateError>;
    putTurn(turn: PendingTurn): Effect.Effect<void, StateError>;
    deleteTurn(chatId: string): Effect.Effect<void, StateError>;
    /** A small named value of the chat, such as the thread schedules post to. */
    meta(key: string): Effect.Effect<string | undefined, StateError>;
    setMeta(key: string, value: string): Effect.Effect<void, StateError>;
    /** True the first time it sees `id`: Telegram redelivers an update that was not answered in time. */
    firstSeen(id: string): Effect.Effect<boolean, StateError>;
  }
>()("mizook/State") {
  static readonly layer = (sql: SqlDriver) =>
    Layer.effect(
      State,
      Effect.gen(function* () {
        const run = <A>(operation: string, f: () => A | Promise<A>) =>
          Effect.tryPromise({
            try: async () => f(),
            catch: (cause) => new StateError({ operation, cause }),
          });

        yield* run("migrate", async () => {
          await sql.all(
            `CREATE TABLE IF NOT EXISTS app_turns (
               chat_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, conversation_id INTEGER NOT NULL,
               request_id TEXT NOT NULL, text TEXT NOT NULL, submissions TEXT NOT NULL,
               logged INTEGER NOT NULL DEFAULT 0)`,
          );
          await sql.all(
            `CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
          );
          await sql.all(
            `CREATE TABLE IF NOT EXISTS app_seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
          );
        });

        return State.of({
          turn: (chatId) =>
            run("turn", () => sql.all(`SELECT * FROM app_turns WHERE chat_id = ?`, chatId)).pipe(
              Effect.flatMap(decodeRows),
              Effect.mapError(asStateError("turn")),
              Effect.map((rows) => rows[0] && toTurn(rows[0])),
            ),
          turns: run("turns", () => sql.all(`SELECT * FROM app_turns`)).pipe(
            Effect.flatMap(decodeRows),
            Effect.mapError(asStateError("turns")),
            Effect.map((rows) => rows.map(toTurn)),
          ),
          putTurn: (t) =>
            run("putTurn", async () => {
              await sql.all(
                `INSERT INTO app_turns (chat_id, thread_id, conversation_id, request_id, text, submissions, logged)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (chat_id) DO UPDATE SET
                   thread_id = excluded.thread_id, conversation_id = excluded.conversation_id,
                   request_id = excluded.request_id, text = excluded.text,
                   submissions = excluded.submissions, logged = excluded.logged`,
                t.chatId,
                t.threadId,
                t.conversationId,
                t.requestId,
                t.text,
                JSON.stringify(t.submissions),
                t.logged ? 1 : 0,
              );
            }),
          deleteTurn: (chatId) =>
            run("deleteTurn", async () => {
              await sql.all(`DELETE FROM app_turns WHERE chat_id = ?`, chatId);
            }),
          meta: (key) =>
            run("meta", async () => {
              const rows = await sql.all<{ value: string }>(
                `SELECT value FROM app_meta WHERE key = ?`,
                key,
              );
              return rows[0]?.value;
            }),
          setMeta: (key, value) =>
            run("setMeta", async () => {
              await sql.all(
                `INSERT INTO app_meta (key, value) VALUES (?, ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
                key,
                value,
              );
            }),
          firstSeen: (id) =>
            run("firstSeen", async () => {
              const now = Date.now();
              await sql.all(`DELETE FROM app_seen WHERE at < ?`, now - WEEK);
              const inserted = await sql.all(
                `INSERT INTO app_seen (id, at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING RETURNING id`,
                id,
                now,
              );
              return inserted.length > 0;
            }),
        });
      }),
    );
}
