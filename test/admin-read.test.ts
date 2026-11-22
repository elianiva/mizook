import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import {
  audit,
  intents,
  memoryView,
  messages,
  overview,
  policies,
  skills,
  usage,
} from "../src/admin/read.ts";

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
  expect(report.byDay).toEqual([
    { day: "2026-01-02", cost: 0.75, calls: 2, input: 2, output: 4, cacheRead: 6 },
  ]);
  expect(report.byModel.map((m) => m.model)).toEqual(["m1", "m2"]);
  expect(report.byKind.map((k) => k.kind)).toEqual(["turn", "memory"]);
});

test("tool calls are counted by the first word, inside the range only, and the audit lists newest first", async () => {
  const { db, sql } = setup();
  db.exec(`CREATE TABLE mem_messages (i INTEGER PRIMARY KEY, kind TEXT, text TEXT, size INTEGER, date TEXT);
    CREATE TABLE app_audit (at INTEGER, who TEXT, action TEXT, target INTEGER, ok INTEGER)`);
  const now = Date.UTC(2026, 0, 10);
  const add = db.prepare(`INSERT INTO mem_messages VALUES (?, ?, ?, 1, ?)`);
  const day = (n: number) => new Date(now - n * 86_400_000).toISOString();
  add.run(0, "tool", 'search {"q":"a"}', day(1));
  add.run(1, "tool", 'search {"q":"b"}', day(2));
  add.run(2, "tool", "skills", day(1));
  add.run(3, "tool", 'search {"q":"old"}', day(20));
  add.run(4, "user", "search is not a tool call", day(1));
  const report = await usage(sql, 7, now);
  expect(report.byTool).toEqual([
    { tool: "search", calls: 2 },
    { tool: "skills", calls: 1 },
  ]);

  const log = db.prepare(`INSERT INTO app_audit VALUES (?, ?, ?, ?, ?)`);
  log.run(1, "a@x", "deny", 7, 1);
  log.run(2, "a@x", "stop", 0, 0);
  expect((await audit(sql)).map((r) => [r.action, r.ok])).toEqual([
    ["stop", false],
    ["deny", true],
  ]);
});

test("skills, intents and policies read as the agent stores them", async () => {
  const { db, sql } = setup();
  db.exec(`CREATE TABLE app_skills (
      name TEXT PRIMARY KEY, description TEXT, body TEXT, created INTEGER, updated INTEGER,
      used_at INTEGER, use_count INTEGER, pinned INTEGER);
    CREATE TABLE app_intents (
      id INTEGER PRIMARY KEY, description TEXT, triggers TEXT, created INTEGER, expires INTEGER,
      cooldown INTEGER, max_fires INTEGER, fire_count INTEGER, last_fired INTEGER, state TEXT);
    CREATE TABLE app_policies (
      id INTEGER PRIMARY KEY, match TEXT, decision TEXT, created INTEGER)`);
  db.prepare(`INSERT INTO app_skills VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "weekly-review",
    "Review the week",
    "steps",
    1,
    2,
    3,
    4,
    1,
  );
  db.prepare(`INSERT INTO app_intents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    7,
    "Check the rollback owner",
    JSON.stringify(["launch", "rollback"]),
    10,
    20,
    30,
    2,
    1,
    null,
    "armed",
  );
  db.prepare(`INSERT INTO app_policies VALUES (?, ?, ?, ?)`).run(3, "gmail.send", "ask", 1);

  expect(await skills(sql)).toEqual([
    {
      name: "weekly-review",
      description: "Review the week",
      body: "steps",
      pinned: true,
      useCount: 4,
      usedAt: 3,
      updated: 2,
    },
  ]);
  expect(await intents(sql)).toEqual([
    {
      id: 7,
      description: "Check the rollback owner",
      triggers: ["launch", "rollback"],
      state: "armed",
      fireCount: 1,
      maxFires: 2,
      cooldown: 30,
      expires: 20,
      lastFired: null,
    },
  ]);
  expect(await policies(sql)).toEqual([{ id: 3, match: "gmail.send", decision: "ask" }]);
});

test("the overview has 14 zero-filled days of spend, oldest first", async () => {
  const { db, sql } = setup();
  db.exec(
    `CREATE TABLE app_usage (at INTEGER, kind TEXT, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cost REAL)`,
  );
  const now = Date.UTC(2026, 0, 20, 12);
  const add = db.prepare(`INSERT INTO app_usage VALUES (?, 'turn', 'm', 1, 1, 1, ?)`);
  add.run(now, 0.5);
  add.run(now - 2 * 86_400_000, 0.25);
  add.run(now - 30 * 86_400_000, 9);
  const o = await overview(sql, now);
  expect(o.daily).toHaveLength(14);
  expect(o.daily.at(-1)).toEqual({ day: "2026-01-20", cost: 0.5 });
  expect(o.daily.at(-2)?.cost).toBe(0);
  expect(o.daily.at(-3)).toEqual({ day: "2026-01-18", cost: 0.25 });
  expect(o.daily[0]?.day).toBe("2026-01-07");
});
