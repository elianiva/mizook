import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { memoryView, messages, overview, usage } from "../src/admin/read.ts";

const setup = () => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return { db, sql };
};

test("a channel with no tables yet reads as empty", async () => {
  const { sql } = setup();
  expect((await overview(sql, 0)).messages).toBe(0);
  expect(await messages(sql, { limit: 10 })).toEqual([]);
  expect(await memoryView(sql)).toEqual([]);
});

test("messages page newest first and search treats % and _ as plain text", async () => {
  const { db, sql } = setup();
  db.exec(
    `CREATE TABLE mem_messages (i INTEGER PRIMARY KEY, kind TEXT, text TEXT, size INTEGER, date TEXT)`,
  );
  const add = db.prepare(`INSERT INTO mem_messages VALUES (?, ?, ?, ?, ?)`);
  ["100% sure", "1000 sure", "a_b", "axb"].forEach((t, i) =>
    add.run(i, i === 2 ? "agent" : "user", t, t.length, "2026-01-01"),
  );
  expect((await messages(sql, { limit: 2 })).map((m) => m.i)).toEqual([3, 2]);
  expect((await messages(sql, { limit: 9, before: 2 })).map((m) => m.i)).toEqual([1, 0]);
  expect((await messages(sql, { limit: 9, q: "%" })).map((m) => m.i)).toEqual([0]);
  expect((await messages(sql, { limit: 9, q: "a_b" })).map((m) => m.i)).toEqual([2]);
  expect((await messages(sql, { limit: 9, kind: "agent" })).map((m) => m.i)).toEqual([2]);
});

test("the memory view names lines as the agent does and usage groups by day and model", async () => {
  const { db, sql } = setup();
  db.exec(`CREATE TABLE mem_nodes (l INTEGER, i INTEGER, text TEXT, size INTEGER, PRIMARY KEY (l, i));
    CREATE TABLE mem_views (id INTEGER PRIMARY KEY, json TEXT);
    CREATE TABLE app_usage (at INTEGER, kind TEXT, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cost REAL)`);
  db.prepare(`INSERT INTO mem_nodes VALUES (2, 1, 'four messages', 13), (0, 8, 'one', 3)`).run();
  db.prepare(`INSERT INTO mem_views VALUES (1, ?)`).run(
    JSON.stringify({
      chat: {
        lines: [
          [2, 1],
          [0, 8],
        ],
        pending: false,
      },
      compaction: { lines: [], pending: false },
    }),
  );
  expect(await memoryView(sql)).toEqual([
    { label: "4+4", level: 2, text: "four messages", size: 13 },
    { label: "8+1", level: 0, text: "one", size: 3 },
  ]);
  const day = Date.UTC(2026, 0, 2);
  const add = db.prepare(`INSERT INTO app_usage VALUES (?, ?, ?, 1, 2, 3, ?)`);
  add.run(day, "turn", "m1", 0.5);
  add.run(day + 1000, "memory", "m2", 0.25);
  add.run(day - 3 * 86_400_000, "turn", "m1", 9);
  const report = await usage(sql, 1, day + 2000);
  expect(report.byDay).toEqual([{ day: "2026-01-02", cost: 0.75, calls: 2 }]);
  expect(report.byModel.map((m) => m.model)).toEqual(["m1", "m2"]);
  expect(report.byKind.map((k) => k.kind)).toEqual(["turn", "memory"]);
});
