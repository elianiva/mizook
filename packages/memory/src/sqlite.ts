import { Effect, Layer } from "effect";
import { StoreError } from "./errors.ts";
import { Store } from "./store.ts";
import type { Kind, Message, Node, PersistedViews } from "./types.ts";

/**
 * The little SQL a store needs, sync or async. Rows come back as plain objects.
 *
 * On a Durable Object that also hosts something with its own transactions, go through that
 * thing's serialized database wrapper, so a write never lands inside someone else's transaction.
 */
export interface SqlDriver {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] | Promise<T[]>;
}

/** A `Store` over SQLite. Tables are prefixed `mem_` so it can share a database with other state. */
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
      });

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
