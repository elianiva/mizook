import { Effect, Layer, Schema } from "effect";
import { StoreError } from "./errors.ts";
import { Store } from "./store.ts";
import type { Kind, Message, Node, PersistedViews, SearchHit, Snapshot } from "./types.ts";

const SearchRow = Schema.Struct({
  i: Schema.Finite,
  kind: Schema.String,
  date: Schema.String,
  snippet: Schema.String,
});
const decodeSearch = Schema.decodeUnknownEffect(Schema.Array(SearchRow));

export interface SqlDriver {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] | Promise<T[]>;
}

export const sqliteStore = (sql: SqlDriver): Layer.Layer<Store, StoreError> =>
  Layer.effect(
    Store,
    Effect.gen(function* () {
      const run = <A>(operation: string, f: () => A | Promise<A>) =>
        Effect.tryPromise({
          try: async () => f(),
          catch: (cause) => new StoreError({ operation, cause }),
        });

      yield* run("migrate", async () => {
        await sql.all(
          `CREATE TABLE IF NOT EXISTS mem_messages (
             i INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
             size INTEGER NOT NULL, date TEXT NOT NULL)`,
        );
        await sql.all(
          `CREATE TABLE IF NOT EXISTS mem_nodes (
             l INTEGER NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL,
             size INTEGER NOT NULL, PRIMARY KEY (l, i))`,
        );
        await sql.all(
          `CREATE TABLE IF NOT EXISTS mem_views (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`,
        );
        await sql.all(
          `CREATE VIRTUAL TABLE IF NOT EXISTS mem_messages_fts USING fts5(
             text, content='mem_messages', content_rowid='i', tokenize='trigram')`,
        );
        await sql.all(
          `CREATE TRIGGER IF NOT EXISTS mem_messages_ai AFTER INSERT ON mem_messages BEGIN
             INSERT INTO mem_messages_fts(rowid, text) VALUES (new.i, new.text);
           END`,
        );
        await sql.all(
          `INSERT INTO mem_messages_fts(rowid, text)
           SELECT i, text FROM mem_messages
           WHERE i NOT IN (SELECT rowid FROM mem_messages_fts)`,
        );
      });

      const scanForTermsTooShortForTrigrams = (text: string, limit: number) =>
        sql.all(
          `SELECT i, kind, date, substr(text, 1, 400) AS snippet
           FROM mem_messages WHERE lower(text) LIKE lower(?)
           ORDER BY i LIMIT ?`,
          `%${text}%`,
          limit,
        );

      const search = (query: string, limit: number) =>
        run("search", async () => {
          const text = query.trim();
          if (text === "") return [];
          const quotedFtsTerms = text
            .split(/\s+/)
            .filter((term) => term !== "")
            .map((term) => `"${term.replaceAll('"', '""')}"`);
          const hits = await sql.all(
            `SELECT m.i, m.kind, m.date,
               snippet(mem_messages_fts, 0, '[', ']', '...', 16) AS snippet
             FROM mem_messages_fts
             JOIN mem_messages m ON m.i = mem_messages_fts.rowid
             WHERE mem_messages_fts MATCH ?
             ORDER BY rank
             LIMIT ?`,
            quotedFtsTerms.join(" AND "),
            limit,
          );
          if (hits.length > 0) return hits;
          return scanForTermsTooShortForTrigrams(text, limit);
        }).pipe(
          Effect.flatMap(decodeSearch),
          Effect.mapError((cause) =>
            cause instanceof StoreError ? cause : new StoreError({ operation: "search", cause }),
          ),
          Effect.map((rows) =>
            rows.map((row): SearchHit => ({
              i: row.i,
              kind: row.kind as Kind,
              date: row.date,
              snippet: row.snippet,
            })),
          ),
        );

      return Store.of({
        messageCount: run(
          "messageCount",
          async () =>
            (await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM mem_messages`))[0]?.n ?? 0,
        ),
        appendMessage: (m) =>
          run("appendMessage", async () => {
            await sql.all(
              `INSERT INTO mem_messages (i, kind, text, size, date) VALUES (?, ?, ?, ?, ?)`,
              m.i,
              m.kind,
              m.text,
              m.size,
              m.date,
            );
          }),
        getMessage: (i) =>
          run("getMessage", async () => {
            const row = (
              await sql.all<Omit<Message, "kind"> & { kind: string }>(
                `SELECT i, kind, text, size, date FROM mem_messages WHERE i = ?`,
                i,
              )
            )[0];
            return row && ({ ...row, kind: row.kind as Kind } satisfies Message);
          }),
        search,
        putNode: (n: Node) =>
          run("putNode", async () => {
            await sql.all(
              `INSERT OR IGNORE INTO mem_nodes (l, i, text, size) VALUES (?, ?, ?, ?)`,
              n.l,
              n.i,
              n.text,
              n.size,
            );
          }),
        getNode: (l, i) =>
          run(
            "getNode",
            async () =>
              (
                await sql.all<Node>(
                  `SELECT l, i, text, size FROM mem_nodes WHERE l = ? AND i = ?`,
                  l,
                  i,
                )
              )[0],
          ),
        nodeSizes: run("nodeSizes", () =>
          sql.all<{ l: number; i: number; size: number }>(`SELECT l, i, size FROM mem_nodes`),
        ),
        loadViews: run("loadViews", async () => {
          const row = (
            await sql.all<{ json: string }>(`SELECT json FROM mem_views WHERE id = 1`)
          )[0];
          return row && (JSON.parse(row.json) as PersistedViews);
        }),
        snapshot: run("snapshot", async () => {
          const messages = (
            await sql.all<Omit<Message, "kind"> & { kind: string }>(
              `SELECT i, kind, text, size, date FROM mem_messages ORDER BY i`,
            )
          ).map((row) => ({ ...row, kind: row.kind as Kind }) satisfies Message);
          const nodes = await sql.all<Node>(`SELECT l, i, text, size FROM mem_nodes ORDER BY l, i`);
          const row = (
            await sql.all<{ json: string }>(`SELECT json FROM mem_views WHERE id = 1`)
          )[0];
          return {
            messages,
            nodes,
            views: row && (JSON.parse(row.json) as PersistedViews),
          } satisfies Snapshot;
        }),
        restore: (snapshot) =>
          run("restore", async () => {
            const count =
              (await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM mem_messages`))[0]?.n ?? 0;
            if (count > 0) throw new Error("the store is not empty");
            for (const m of snapshot.messages) {
              await sql.all(
                `INSERT INTO mem_messages (i, kind, text, size, date) VALUES (?, ?, ?, ?, ?)`,
                m.i,
                m.kind,
                m.text,
                m.size,
                m.date,
              );
            }
            for (const n of snapshot.nodes) {
              await sql.all(
                `INSERT OR IGNORE INTO mem_nodes (l, i, text, size) VALUES (?, ?, ?, ?)`,
                n.l,
                n.i,
                n.text,
                n.size,
              );
            }
            if (snapshot.views) {
              await sql.all(
                `INSERT INTO mem_views (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json`,
                JSON.stringify(snapshot.views),
              );
            }
          }),
        saveViews: (views: PersistedViews) =>
          run("saveViews", async () => {
            await sql.all(
              `INSERT INTO mem_views (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json`,
              JSON.stringify(views),
            );
          }),
      });
    }),
  );
