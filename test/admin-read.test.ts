import { Arbitrary, Effect, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
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
import { property } from "./property.ts";

const DAY = 86_400_000;

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

const oneOf = <const A extends ReadonlyArray<string>>(values: A) =>
  Arbitrary.schema(Schema.Literals(values));

const io =
  <A>(check: (value: A) => Promise<void>) =>
  (value: A) =>
    Effect.promise(() => check(value));

const join = (parts: ReadonlyArray<string>) => parts.join("");

const setup = () => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return { db, sql };
};

const shuffled = <A>(items: ReadonlyArray<A>, keys: ReadonlyArray<number>) =>
  items
    .map((item, k) => ({ item, key: keys[k % Math.max(1, keys.length)] ?? 0, k }))
    .sort((a, b) => a.key - b.key || a.k - b.k)
    .map((x) => x.item);

const dayOf = (epochMs: number) => {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

const now = int(1_700_000_000_000, 1_900_000_000_000);

property(
  "a channel with no tables yet reads as empty for every page",
  Arbitrary.all({ now, days: int(1, 90), limit: int(0, 50) }),
  io(async ({ now, days, limit }) => {
    const { sql } = setup();
    const o = await overview(sql, now);
    expect(o).toMatchObject({
      messages: 0,
      nodes: 0,
      viewLines: 0,
      spend: { last24h: 0, last7d: 0, total: 0 },
      settings: {},
      turns: [],
      approvals: [],
    });
    expect(o.daily.map((d) => d.cost)).toEqual(Array.from({ length: 14 }, () => 0));
    expect(await messages(sql, { limit })).toEqual([]);
    expect(await memoryView(sql)).toEqual([]);
    expect(await usage(sql, days, now)).toEqual({ byDay: [], byTool: [], byModel: [], byKind: [] });
    expect(await skills(sql)).toEqual([]);
    expect(await intents(sql)).toEqual([]);
    expect(await policies(sql)).toEqual([]);
    expect(await audit(sql)).toEqual([]);
  }),
  { runs: 20 },
);

const KINDS = ["user", "agent", "tool", "echo", "note"] as const;
const glyph = oneOf(["a", "B", "b", "%", "_", "\\", " ", "é", "É", "日", "🙂", "'", "x"]);
const shortText = Arbitrary.map(Arbitrary.array(glyph, { maxLength: 8 }), join);
const longText = Arbitrary.map(
  Arbitrary.all({ head: shortText, fill: int(590, 610), tail: oneOf(["", "🙂", "é"]) }),
  ({ head, fill, tail }) => head + "y".repeat(fill) + tail,
);
const logText = Arbitrary.flatMap(int(0, 4), (k) => (k === 0 ? longText : shortText));

const log = Arbitrary.map(
  Arbitrary.array(
    Arbitrary.all({ gap: int(1, 3), kind: oneOf(KINDS), text: logText, size: int(0, 3000) }),
    { maxLength: 25 },
  ),
  (rows) => {
    let i = -1;
    return rows.map((r) => ({ ...r, i: (i += r.gap) }));
  },
);

const asciiFold = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

property(
  "messages are the newest matches first, below the cursor, up to the limit, with % _ and \\ searched as plain text",
  Arbitrary.all({
    rows: log,
    kind: Arbitrary.flatMap(int(0, 2), (k) =>
      k === 0 ? Arbitrary.Constant(undefined) : oneOf([...KINDS, "bogus", ""]),
    ),
    q: Arbitrary.flatMap(int(0, 2), (k) =>
      k === 0
        ? Arbitrary.Constant(undefined)
        : Arbitrary.map(Arbitrary.array(glyph, { minLength: 1, maxLength: 3 }), join),
    ),
    before: Arbitrary.flatMap(int(0, 1), (k) =>
      k === 0 ? Arbitrary.Constant(undefined) : int(-1, 80),
    ),
    limit: int(0, 30),
    order: Arbitrary.array(int(0, 1000)),
  }),
  io(async ({ rows, kind, q, before, limit, order }) => {
    const { db, sql } = setup();
    db.exec(
      `CREATE TABLE mem_messages (i INTEGER PRIMARY KEY, kind TEXT, text TEXT, size INTEGER, date TEXT)`,
    );
    const add = db.prepare(`INSERT INTO mem_messages VALUES (?, ?, ?, ?, ?)`);
    for (const r of shuffled(rows, order)) add.run(r.i, r.kind, r.text, r.size, "2026-01-01");
    const expected = rows
      .filter((r) => !kind || !(KINDS as ReadonlyArray<string>).includes(kind) || r.kind === kind)
      .filter((r) => !q || asciiFold(r.text).includes(asciiFold(q)))
      .filter((r) => before === undefined || r.i < before)
      .reverse()
      .slice(0, limit)
      .map((r) => ({
        i: r.i,
        kind: r.kind,
        text: r.text.slice(0, 600),
        size: r.size,
        date: "2026-01-01",
        cut: r.text.length > 600 || r.size > 2400,
      }));
    expect(
      await messages(sql, {
        limit,
        ...(kind !== undefined && { kind }),
        ...(q !== undefined && { q }),
        ...(before !== undefined && { before }),
      }),
    ).toEqual(expected);
  }),
);

const nodeKey = Arbitrary.all({ l: int(0, 12), i: int(0, 40) });

property(
  "the memory view lists its lines in order, labelled first message plus count covered, with each node's text",
  Arbitrary.all({
    nodes: Arbitrary.array(Arbitrary.all({ key: nodeKey, text: shortText, size: int(0, 512) }), {
      maxLength: 15,
    }),
    lines: Arbitrary.array(nodeKey, { maxLength: 15 }),
  }),
  io(async ({ nodes, lines }) => {
    const { db, sql } = setup();
    db.exec(`CREATE TABLE mem_nodes (l INTEGER, i INTEGER, text TEXT, size INTEGER, PRIMARY KEY (l, i));
      CREATE TABLE mem_views (id INTEGER PRIMARY KEY, json TEXT)`);
    const stored = new Map<string, { text: string; size: number }>();
    const add = db.prepare(`INSERT OR IGNORE INTO mem_nodes VALUES (?, ?, ?, ?)`);
    for (const n of nodes) {
      const key = `${n.key.l}/${n.key.i}`;
      if (!stored.has(key)) stored.set(key, { text: n.text, size: n.size });
      add.run(n.key.l, n.key.i, n.text, n.size);
    }
    db.prepare(`INSERT INTO mem_views VALUES (1, ?)`).run(
      JSON.stringify({
        chat: { lines: lines.map((k) => [k.l, k.i]), pending: false },
        compaction: { lines: [], pending: false },
      }),
    );
    expect(await memoryView(sql)).toEqual(
      lines.map(({ l, i }) => {
        let covered = 1;
        for (let k = 0; k < l; k++) covered += covered;
        return {
          label: `${i * covered}+${covered}`,
          level: l,
          text: stored.get(`${l}/${i}`)?.text ?? "",
          size: stored.get(`${l}/${i}`)?.size ?? 0,
        };
      }),
    );
    expect((await overview(sql, 0)).viewLines).toBe(lines.length);
  }),
);

const usageRows = (windowDays: number) =>
  Arbitrary.array(
    Arbitrary.all({
      offset: Arbitrary.flatMap(int(0, 2), (k) =>
        k === 0 ? int(-2, 2) : int(-3 * DAY, (windowDays + 1) * DAY),
      ),
      kind: oneOf(["turn", "memory", "search"]),
      model: oneOf(["m1", "m2", "m3"]),
      input: int(0, 1000),
      output: int(0, 1000),
      cacheRead: int(0, 1000),
      cost: Arbitrary.map(int(0, 4096), (k) => k / 64),
    }),
    { maxLength: 25 },
  );

const groupSum = <R, K extends string>(
  rows: ReadonlyArray<R>,
  key: (r: R) => K,
  fields: (r: R) => Record<string, number>,
) => {
  const groups = new Map<K, Record<string, number>>();
  for (const r of rows) {
    const total = groups.get(key(r)) ?? {};
    for (const [f, v] of Object.entries(fields(r))) total[f] = (total[f] ?? 0) + v;
    groups.set(key(r), total);
  }
  return groups;
};

const nonIncreasing = (values: ReadonlyArray<number>) =>
  values.every((v, k) => k === 0 || values[k - 1]! >= v);

property(
  "usage sums cost, calls and tokens by UTC day, by model and by kind, from the start of the range inclusive",
  Arbitrary.flatMap(int(1, 20), (days) =>
    Arbitrary.all({ days: Arbitrary.Constant(days), now, rows: usageRows(days) }),
  ),
  io(async ({ days, now, rows }) => {
    const { db, sql } = setup();
    db.exec(
      `CREATE TABLE app_usage (at INTEGER, kind TEXT, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cost REAL)`,
    );
    const since = now - days * DAY;
    const add = db.prepare(`INSERT INTO app_usage VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const placed = rows.map((r) => ({ ...r, at: since + r.offset }));
    for (const r of placed) add.run(r.at, r.kind, r.model, r.input, r.output, r.cacheRead, r.cost);
    const inRange = placed.filter((r) => r.at >= since);
    const totals = (r: (typeof placed)[number]) => ({
      cost: r.cost,
      calls: 1,
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
    });
    const report = await usage(sql, days, now);

    const byDay = groupSum(inRange, (r) => dayOf(r.at), totals);
    expect(report.byDay).toEqual(
      [...byDay.keys()].sort().map((day) => ({ day, ...byDay.get(day) })),
    );

    const byModel = groupSum(inRange, (r) => r.model, totals);
    expect(new Map(report.byModel.map(({ model, ...rest }) => [model, rest]))).toEqual(byModel);
    expect(report.byModel).toHaveLength(byModel.size);
    expect(nonIncreasing(report.byModel.map((m) => m.cost))).toBe(true);

    const byKind = groupSum(
      inRange,
      (r) => r.kind,
      (r) => ({ cost: r.cost, calls: 1 }),
    );
    expect(new Map(report.byKind.map(({ kind, ...rest }) => [kind, rest]))).toEqual(byKind);
    expect(report.byKind).toHaveLength(byKind.size);
    expect(nonIncreasing(report.byKind.map((k) => k.cost))).toBe(true);
  }),
  { runs: 60 },
);

const TOOLS = [
  "search",
  "skills",
  "web",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
] as const;

property(
  "tool calls in range are counted by first word, most used first, at most twelve, and other kinds never count",
  Arbitrary.all({
    now,
    days: int(1, 30),
    calls: Arbitrary.array(
      Arbitrary.all({
        tool: oneOf(TOOLS),
        rest: oneOf(["", ' {"q":"x"}', " x y", "\tz"]),
        kind: Arbitrary.flatMap(int(0, 3), (k) =>
          k === 0 ? oneOf(KINDS) : Arbitrary.Constant("tool"),
        ),
        ageDays: Arbitrary.flatMap(int(0, 2), (k) =>
          k === 0 ? int(-1, 1) : int(-2 * DAY, 40 * DAY),
        ),
      }),
      { maxLength: 40 },
    ),
  }),
  io(async ({ now, days, calls }) => {
    const { db, sql } = setup();
    db.exec(
      `CREATE TABLE mem_messages (i INTEGER PRIMARY KEY, kind TEXT, text TEXT, size INTEGER, date TEXT)`,
    );
    const since = now - days * DAY;
    const add = db.prepare(`INSERT INTO mem_messages VALUES (?, ?, ?, 1, ?)`);
    const placed = calls.map((c, i) => ({ ...c, i, at: since + c.ageDays }));
    for (const c of placed)
      add.run(c.i, c.kind, `${c.tool}${c.rest}`, new Date(c.at).toISOString());
    const counts = new Map<string, number>();
    for (const c of placed) {
      if (c.kind !== "tool" || c.at < since) continue;
      const name = `${c.tool}${c.rest}`.split(" ")[0]!;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const { byTool } = await usage(sql, days, now);
    expect(byTool).toHaveLength(Math.min(12, counts.size));
    expect(nonIncreasing(byTool.map((t) => t.calls))).toBe(true);
    for (const t of byTool) expect(t.calls).toBe(counts.get(t.tool));
    const shown = new Set(byTool.map((t) => t.tool));
    const least = Math.min(...byTool.map((t) => t.calls));
    for (const [tool, n] of counts) if (!shown.has(tool)) expect(n).toBeLessThanOrEqual(least);
  }),
);

property(
  "the audit lists the newest hundred entries first whatever order they were written in",
  Arbitrary.all({
    entries: Arbitrary.array(
      Arbitrary.all({
        gap: int(1, 1000),
        who: oneOf(["a@x", "b@y", "ü@z"]),
        action: oneOf(["deny", "approve", "stop", "cancel_schedule"]),
        target: int(0, 100),
        ok: int(0, 1),
      }),
      { maxLength: 130 },
    ),
    order: Arbitrary.array(int(0, 1000), { maxLength: 130 }),
  }),
  io(async ({ entries, order }) => {
    const { db, sql } = setup();
    db.exec(
      `CREATE TABLE app_audit (at INTEGER, who TEXT, action TEXT, target INTEGER, ok INTEGER)`,
    );
    let at = 0;
    const timed = entries.map((e) => ({ ...e, at: (at += e.gap) }));
    const log = db.prepare(`INSERT INTO app_audit VALUES (?, ?, ?, ?, ?)`);
    for (const e of shuffled(timed, order)) log.run(e.at, e.who, e.action, e.target, e.ok);
    expect(await audit(sql)).toEqual(
      [...timed]
        .reverse()
        .slice(0, 100)
        .map((e) => ({ at: e.at, who: e.who, action: e.action, target: e.target, ok: e.ok === 1 })),
    );
  }),
  { runs: 40 },
);

const name = Arbitrary.schema(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,20}$/)));
const anyText = Arbitrary.map(Arbitrary.schema(Schema.String), (s) => s.replace(/\p{Cs}/gu, "?"));
const maybeTime = Arbitrary.flatMap(int(0, 2), (k) =>
  k === 0 ? Arbitrary.Constant(null) : int(0, 2_000_000_000_000),
);

property(
  "skills read back by name with every stored field, pinned only when the flag is 1",
  Arbitrary.all({
    rows: Arbitrary.array(
      Arbitrary.all({
        name,
        description: anyText,
        body: anyText,
        updated: int(0, 2_000_000_000_000),
        usedAt: maybeTime,
        useCount: int(0, 10_000),
        pinned: int(0, 1),
      }),
      { maxLength: 10 },
    ),
    order: Arbitrary.array(int(0, 100)),
  }),
  io(async ({ rows, order }) => {
    const { db, sql } = setup();
    db.exec(`CREATE TABLE app_skills (
      name TEXT PRIMARY KEY, description TEXT, body TEXT, created INTEGER, updated INTEGER,
      used_at INTEGER, use_count INTEGER, pinned INTEGER)`);
    const unique = [...new Map(rows.map((r) => [r.name, r])).values()];
    const add = db.prepare(`INSERT INTO app_skills VALUES (?, ?, ?, 0, ?, ?, ?, ?)`);
    for (const r of shuffled(unique, order))
      add.run(r.name, r.description, r.body, r.updated, r.usedAt, r.useCount, r.pinned);
    expect(await skills(sql)).toEqual(
      [...unique]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((r) => ({
          name: r.name,
          description: r.description,
          body: r.body,
          pinned: r.pinned === 1,
          useCount: r.useCount,
          usedAt: r.usedAt,
          updated: r.updated,
        })),
    );
  }),
  { runs: 50 },
);

const triggers = Arbitrary.flatMap(int(0, 4), (form) => {
  if (form === 0)
    return Arbitrary.map(oneOf(["not json", "{}", '"launch"', "null", "7"]), (json) => ({
      json,
      read: [] as string[],
    }));
  return Arbitrary.map(
    Arbitrary.array(
      Arbitrary.flatMap(int(0, 4), (k) =>
        k === 0
          ? Arbitrary.map(oneOf(["n", "t", "o"]), (v): unknown =>
              v === "n" ? null : v === "t" ? true : { o: 1 },
            )
          : Arbitrary.map(anyText, (s): unknown => s),
      ),
      { maxLength: 6 },
    ),
    (items) => ({
      json: JSON.stringify(items),
      read: items.filter((t): t is string => typeof t === "string"),
    }),
  );
});

property(
  "intents read back by id with their string triggers, and triggers that are not a JSON list read as none",
  Arbitrary.all({
    rows: Arbitrary.array(
      Arbitrary.all({
        id: int(1, 10_000),
        description: anyText,
        triggers,
        created: int(0, 2_000_000_000_000),
        expires: int(0, 2_000_000_000_000),
        cooldown: int(0, 1_000_000_000),
        maxFires: int(1, 1000),
        fireCount: int(0, 1000),
        lastFired: maybeTime,
        state: oneOf(["armed", "done", "cancelled", "expired"]),
      }),
      { maxLength: 10 },
    ),
    order: Arbitrary.array(int(0, 100)),
  }),
  io(async ({ rows, order }) => {
    const { db, sql } = setup();
    db.exec(`CREATE TABLE app_intents (
      id INTEGER PRIMARY KEY, description TEXT, triggers TEXT, created INTEGER, expires INTEGER,
      cooldown INTEGER, max_fires INTEGER, fire_count INTEGER, last_fired INTEGER, state TEXT)`);
    const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
    const add = db.prepare(`INSERT INTO app_intents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of shuffled(unique, order))
      add.run(
        r.id,
        r.description,
        r.triggers.json,
        r.created,
        r.expires,
        r.cooldown,
        r.maxFires,
        r.fireCount,
        r.lastFired,
        r.state,
      );
    expect(await intents(sql)).toEqual(
      [...unique]
        .sort((a, b) => a.id - b.id)
        .map((r) => ({
          id: r.id,
          description: r.description,
          triggers: r.triggers.read,
          state: r.state,
          fireCount: r.fireCount,
          maxFires: r.maxFires,
          cooldown: r.cooldown,
          expires: r.expires,
          lastFired: r.lastFired,
        })),
    );
  }),
  { runs: 50 },
);

property(
  "policies read back by id with their match and decision",
  Arbitrary.all({
    rows: Arbitrary.array(
      Arbitrary.all({
        id: int(1, 10_000),
        match: anyText,
        decision: oneOf(["allow", "ask", "deny"]),
      }),
      { maxLength: 10 },
    ),
    order: Arbitrary.array(int(0, 100)),
  }),
  io(async ({ rows, order }) => {
    const { db, sql } = setup();
    db.exec(
      `CREATE TABLE app_policies (id INTEGER PRIMARY KEY, match TEXT, decision TEXT, created INTEGER)`,
    );
    const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
    const add = db.prepare(`INSERT INTO app_policies VALUES (?, ?, ?, 0)`);
    for (const r of shuffled(unique, order)) add.run(r.id, r.match, r.decision);
    expect(await policies(sql)).toEqual(
      [...unique]
        .sort((a, b) => a.id - b.id)
        .map((r) => ({ id: r.id, match: r.match, decision: r.decision })),
    );
  }),
  { runs: 50 },
);

property(
  "the overview spend covers the last day, week and all time, and the daily chart is 14 zero-filled UTC days ending today",
  Arbitrary.all({
    now,
    rows: Arbitrary.array(
      Arbitrary.all({
        ago: Arbitrary.flatMap(int(0, 3), (k) =>
          k === 0
            ? oneOf(["day", "week"]).pipe(
                Arbitrary.flatMap((edge) =>
                  Arbitrary.map(int(-1, 1), (d) => (edge === "day" ? DAY : 7 * DAY) + d),
                ),
              )
            : int(0, 30 * DAY),
        ),
        cost: Arbitrary.map(int(0, 4096), (k) => k / 64),
      }),
      { maxLength: 30 },
    ),
  }),
  io(async ({ now, rows }) => {
    const { db, sql } = setup();
    db.exec(
      `CREATE TABLE app_usage (at INTEGER, kind TEXT, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cost REAL)`,
    );
    const add = db.prepare(`INSERT INTO app_usage VALUES (?, 'turn', 'm', 1, 1, 1, ?)`);
    const placed = rows.map((r) => ({ at: now - r.ago, cost: r.cost }));
    for (const r of placed) add.run(r.at, r.cost);
    const spent = (since: number) =>
      placed.filter((r) => r.at >= since).reduce((sum, r) => sum + r.cost, 0);
    const today = new Date(now);
    const days = Array.from({ length: 14 }, (_, k) =>
      dayOf(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 13 + k)),
    );
    const o = await overview(sql, now);
    expect(o.spend).toEqual({
      last24h: spent(now - DAY),
      last7d: spent(now - 7 * DAY),
      total: spent(0),
    });
    expect(o.daily).toEqual(
      days.map((day) => ({
        day,
        cost: placed.filter((r) => dayOf(r.at) === day).reduce((sum, r) => sum + r.cost, 0),
      })),
    );
  }),
  { runs: 60 },
);

property(
  "the overview counts messages and nodes, shows only setting: keys, cuts turn previews at 600 and reports which approvals were posted",
  Arbitrary.all({
    messageCount: int(0, 30),
    nodeCount: int(0, 30),
    meta: Arbitrary.array(
      Arbitrary.all({
        prefix: oneOf(["setting:", "other:", "settings", "xsetting:", ""]),
        key: name,
        value: anyText,
      }),
      { maxLength: 8 },
    ),
    turns: Arbitrary.array(Arbitrary.all({ chat: anyText, text: logText }), { maxLength: 5 }),
    approvals: Arbitrary.array(Arbitrary.all({ summary: anyText, posted: int(0, 2) }), {
      maxLength: 6,
    }),
  }),
  io(async ({ messageCount, nodeCount, meta, turns, approvals }) => {
    const { db, sql } = setup();
    db.exec(`CREATE TABLE mem_messages (i INTEGER PRIMARY KEY, kind TEXT, text TEXT, size INTEGER, date TEXT);
      CREATE TABLE mem_nodes (l INTEGER, i INTEGER, text TEXT, size INTEGER, PRIMARY KEY (l, i));
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE app_turns (chat_id TEXT, text TEXT);
      CREATE TABLE app_approvals (id INTEGER PRIMARY KEY, summary TEXT, posted INTEGER)`);
    for (let i = 0; i < messageCount; i++)
      db.prepare(`INSERT INTO mem_messages VALUES (?, 'user', 'x', 1, '')`).run(i);
    for (let i = 0; i < nodeCount; i++)
      db.prepare(`INSERT INTO mem_nodes VALUES (0, ?, 'x', 1)`).run(i);
    const stored = new Map<string, string>();
    for (const m of meta) {
      const key = `${m.prefix}${m.key}`;
      if (stored.has(key)) continue;
      stored.set(key, m.value);
      db.prepare(`INSERT INTO app_meta VALUES (?, ?)`).run(key, m.value);
    }
    for (const t of turns) db.prepare(`INSERT INTO app_turns VALUES (?, ?)`).run(t.chat, t.text);
    approvals.forEach((a, k) =>
      db.prepare(`INSERT INTO app_approvals VALUES (?, ?, ?)`).run(k + 1, a.summary, a.posted),
    );
    const o = await overview(sql, 1_800_000_000_000);
    expect(o.messages).toBe(messageCount);
    expect(o.nodes).toBe(nodeCount);
    expect(o.settings).toEqual(
      Object.fromEntries(
        [...stored].filter(([k]) => k.startsWith("setting:")).map(([k, v]) => [k.slice(8), v]),
      ),
    );
    expect(o.turns).toEqual(turns.map((t) => ({ chatId: t.chat, text: t.text.slice(0, 600) })));
    expect(o.approvals).toEqual(
      approvals.map((a, k) => ({ id: k + 1, summary: a.summary, posted: a.posted === 1 })),
    );
  }),
  { runs: 40 },
);
