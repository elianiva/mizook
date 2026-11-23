import { Context, Effect, Layer, Schema } from "effect";
import type { SqlDriver } from "@mizook/memory/sqlite";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import type { StateError } from "./errors.ts";
import { stateSql } from "./sql.ts";

export interface PendingTurn {
  readonly chatId: string;
  readonly threadId: string;
  readonly conversationId: ConversationId;
  readonly requestId: string;
  readonly text: string;
  readonly submissions: ReadonlyArray<SubmissionId>;
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

const toTurn = (row: typeof Row.Type): PendingTurn => ({
  chatId: row.chat_id,
  threadId: row.thread_id,
  conversationId: row.conversation_id as ConversationId,
  requestId: row.request_id,
  text: row.text,
  submissions: row.submissions as SubmissionId[],
  logged: row.logged === 1,
});

export interface ThreadLine {
  readonly role: "user" | "agent";
  readonly text: string;
}

const THREAD_LINES_KEPT = 100;

const WEEK = 7 * 24 * 3600 * 1000;

export class State extends Context.Service<
  State,
  {
    turn(chatId: string): Effect.Effect<PendingTurn | undefined, StateError>;
    readonly turns: Effect.Effect<ReadonlyArray<PendingTurn>, StateError>;
    putTurn(turn: PendingTurn): Effect.Effect<void, StateError>;
    deleteTurn(chatId: string): Effect.Effect<void, StateError>;
    /** What was said in one place, oldest first: all a web thread's turn gets to see. */
    thread(place: string): Effect.Effect<ReadonlyArray<ThreadLine>, StateError>;
    say(place: string, role: ThreadLine["role"], text: string): Effect.Effect<void, StateError>;
    meta(key: string): Effect.Effect<string | undefined, StateError>;
    setMeta(key: string, value: string): Effect.Effect<void, StateError>;
    deleteMeta(key: string): Effect.Effect<void, StateError>;
    readonly settings: Effect.Effect<Record<string, string>, StateError>;
    audit(
      who: string,
      action: string,
      target: number,
      ok: boolean,
    ): Effect.Effect<void, StateError>;
    firstSeen(id: string): Effect.Effect<boolean, StateError>;
  }
>()("mizook/State") {
  static readonly layer = (sql: SqlDriver) =>
    Layer.effect(
      State,
      Effect.gen(function* () {
        const { run, rows } = stateSql(sql);
        const turnRows = rows(Row);

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
            `CREATE TABLE IF NOT EXISTS app_thread (
               id INTEGER PRIMARY KEY AUTOINCREMENT, place TEXT NOT NULL,
               role TEXT NOT NULL, text TEXT NOT NULL)`,
          );
          await sql.all(`CREATE INDEX IF NOT EXISTS app_thread_place ON app_thread (place, id)`);
          await sql.all(
            `CREATE TABLE IF NOT EXISTS app_audit (
               at INTEGER NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL,
               target INTEGER NOT NULL, ok INTEGER NOT NULL)`,
          );
          await sql.all(
            `CREATE TABLE IF NOT EXISTS app_seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
          );
        });

        return State.of({
          turn: (chatId) =>
            turnRows("turn", `SELECT * FROM app_turns WHERE chat_id = ?`, chatId).pipe(
              Effect.map((found) => found[0] && toTurn(found[0])),
            ),
          turns: turnRows("turns", `SELECT * FROM app_turns`).pipe(
            Effect.map((found) => found.map(toTurn)),
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
          thread: (place) =>
            rows(Schema.Struct({ role: Schema.String, text: Schema.String }))(
              "thread",
              `SELECT role, text FROM (
                 SELECT id, role, text FROM app_thread WHERE place = ? ORDER BY id DESC LIMIT ?
               ) ORDER BY id ASC`,
              place,
              THREAD_LINES_KEPT,
            ).pipe(
              Effect.map((found) =>
                found.map((r) => ({
                  role: r.role === "agent" ? ("agent" as const) : ("user" as const),
                  text: r.text,
                })),
              ),
            ),
          say: (place, role, text) =>
            run("say", async () => {
              await sql.all(
                `INSERT INTO app_thread (place, role, text) VALUES (?, ?, ?)`,
                place,
                role,
                text,
              );
              await sql.all(
                `DELETE FROM app_thread WHERE place = ? AND id <= (
                   SELECT id FROM app_thread WHERE place = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
                place,
                place,
                THREAD_LINES_KEPT,
              );
            }),
          meta: (key) =>
            run("meta", async () => {
              const rows = await sql.all<{ value: string }>(
                `SELECT value FROM app_meta WHERE key = ?`,
                key,
              );
              return rows[0]?.value;
            }),
          deleteMeta: (key) =>
            run("deleteMeta", async () => {
              await sql.all(`DELETE FROM app_meta WHERE key = ?`, key);
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
          settings: readSettings(sql),
          audit: (who, action, target, ok) =>
            run("audit", async () => {
              const now = Date.now();
              await sql.all(`DELETE FROM app_audit WHERE at < ?`, now - 90 * 24 * 3600 * 1000);
              await sql.all(
                `INSERT INTO app_audit (at, who, action, target, ok) VALUES (?, ?, ?, ?, ?)`,
                now,
                who,
                action,
                target,
                ok ? 1 : 0,
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

export const readSettings = (sql: SqlDriver) => {
  const { run, rows } = stateSql(sql);
  return run("read settings", () =>
    sql.all(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
  ).pipe(
    Effect.andThen(
      rows(Schema.Struct({ key: Schema.String, value: Schema.String }))(
        "read settings",
        `SELECT key, value FROM app_meta WHERE key GLOB 'setting:*'`,
      ),
    ),
    Effect.map((found) =>
      Object.fromEntries(found.map((r) => [r.key.slice("setting:".length), r.value])),
    ),
  );
};
