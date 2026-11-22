import type { SqlDriver } from "@mizook/memory/sqlite";

const rowsOrEmpty = async <T>(sql: SqlDriver, text: string, ...params: unknown[]): Promise<T[]> => {
  try {
    return await sql.all<T>(text, ...params);
  } catch {
    return [];
  }
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MESSAGE_PREVIEW_CHARS = 600;
const DAILY_SPEND_DAYS = 14;

export interface Overview {
  readonly messages: number;
  readonly nodes: number;
  readonly viewLines: number;
  readonly spend: { readonly last24h: number; readonly last7d: number; readonly total: number };
  readonly settings: Record<string, string>;
  readonly turns: ReadonlyArray<{ chatId: string; text: string }>;
  readonly approvals: ReadonlyArray<{ id: number; summary: string; posted: boolean }>;
  readonly schedules: number;
  readonly daily: ReadonlyArray<{ day: string; cost: number }>;
  readonly nextSchedule: number | null;
}

const count = async (sql: SqlDriver, table: string) =>
  (await rowsOrEmpty<{ n: number }>(sql, `SELECT COUNT(*) AS n FROM ${table}`))[0]?.n ?? 0;

const spentSince = async (sql: SqlDriver, since: number) =>
  (
    await rowsOrEmpty<{ total: number | null }>(
      sql,
      `SELECT SUM(cost) AS total FROM app_usage WHERE at >= ?`,
      since,
    )
  )[0]?.total ?? 0;

const SCHEDULE_COUNT_FILLED_IN_BY_WORKER = 0;

const dailySpend = async (sql: SqlDriver, now: number) => {
  const found = await rowsOrEmpty<{ day: string; cost: number }>(
    sql,
    `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, SUM(cost) AS cost
     FROM app_usage WHERE at >= ? GROUP BY day`,
    now - DAILY_SPEND_DAYS * DAY,
  );
  const byDay = new Map(found.map((r) => [r.day, r.cost]));
  return Array.from({ length: DAILY_SPEND_DAYS }, (_, k) => {
    const day = new Date(now - (13 - k) * DAY).toISOString().slice(0, 10);
    return { day, cost: byDay.get(day) ?? 0 };
  });
};

export const overview = async (sql: SqlDriver, now: number): Promise<Overview> => {
  const views = (await rowsOrEmpty<{ json: string }>(sql, `SELECT json FROM mem_views`))[0]?.json;
  const lines = views ? (JSON.parse(views) as { chat: { lines: unknown[] } }).chat.lines.length : 0;
  const settings = await rowsOrEmpty<{ key: string; value: string }>(
    sql,
    `SELECT key, value FROM app_meta WHERE key LIKE 'setting:%'`,
  );
  return {
    messages: await count(sql, "mem_messages"),
    nodes: await count(sql, "mem_nodes"),
    viewLines: lines,
    spend: {
      last24h: await spentSince(sql, now - DAY),
      last7d: await spentSince(sql, now - 7 * DAY),
      total: await spentSince(sql, 0),
    },
    settings: Object.fromEntries(settings.map((s) => [s.key.slice("setting:".length), s.value])),
    turns: (
      await rowsOrEmpty<{ chat_id: string; text: string }>(
        sql,
        `SELECT chat_id, text FROM app_turns`,
      )
    ).map((t) => ({ chatId: t.chat_id, text: t.text.slice(0, MESSAGE_PREVIEW_CHARS) })),
    approvals: (
      await rowsOrEmpty<{ id: number; summary: string; posted: number }>(
        sql,
        `SELECT id, summary, posted FROM app_approvals ORDER BY id`,
      )
    ).map((a) => ({ id: a.id, summary: a.summary, posted: a.posted === 1 })),
    schedules: SCHEDULE_COUNT_FILLED_IN_BY_WORKER,
    daily: await dailySpend(sql, now),
    nextSchedule: null,
  };
};

export interface LogMessage {
  readonly i: number;
  readonly kind: string;
  readonly text: string;
  readonly size: number;
  readonly date: string;
  readonly cut: boolean;
}

const KINDS = ["user", "agent", "tool", "echo", "note"];

export const messages = async (
  sql: SqlDriver,
  options: { kind?: string; q?: string; before?: number; limit: number },
): Promise<LogMessage[]> => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.kind && KINDS.includes(options.kind)) {
    where.push("kind = ?");
    params.push(options.kind);
  }
  if (options.q) {
    where.push(`text LIKE ? ESCAPE '\\'`);
    params.push(`%${options.q.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (options.before !== undefined) {
    where.push("i < ?");
    params.push(options.before);
  }
  const found = await rowsOrEmpty<{
    i: number;
    kind: string;
    text: string;
    size: number;
    date: string;
  }>(
    sql,
    `SELECT i, kind, substr(text, 1, ${MESSAGE_PREVIEW_CHARS + 1}) AS text, size, date FROM mem_messages
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY i DESC LIMIT ?`,
    ...params,
    options.limit,
  );
  return found.map((m) => ({
    ...m,
    text: m.text.slice(0, MESSAGE_PREVIEW_CHARS),
    cut: m.text.length > MESSAGE_PREVIEW_CHARS || m.size > MESSAGE_PREVIEW_CHARS * 4,
  }));
};

export const message = async (sql: SqlDriver, i: number) =>
  (
    await rowsOrEmpty<{
      i: number;
      kind: string;
      text: string;
      size: number;
      date: string;
    }>(sql, `SELECT i, kind, text, size, date FROM mem_messages WHERE i = ?`, i)
  )[0];

export interface ViewLine {
  readonly label: string;
  readonly level: number;
  readonly text: string;
  readonly size: number;
}

export const memoryView = async (sql: SqlDriver): Promise<ViewLine[]> => {
  const json = (await rowsOrEmpty<{ json: string }>(sql, `SELECT json FROM mem_views`))[0]?.json;
  if (!json) return [];
  const lines = (JSON.parse(json) as { chat: { lines: Array<[number, number]> } }).chat.lines;
  const nodes = await rowsOrEmpty<{
    l: number;
    i: number;
    text: string;
    size: number;
  }>(sql, `SELECT n.l, n.i, n.text, n.size FROM mem_nodes n`);
  const byKey = new Map(nodes.map((n) => [`${n.l}:${n.i}`, n]));
  return lines.map(([l, i]) => {
    const node = byKey.get(`${l}:${i}`);
    const messagesCovered = 2 ** l;
    const firstMessageId = i * messagesCovered;
    return {
      label: `${firstMessageId}+${messagesCovered}`,
      level: l,
      text: node?.text ?? "",
      size: node?.size ?? 0,
    };
  });
};

export interface UsageReport {
  readonly byDay: ReadonlyArray<{
    day: string;
    cost: number;
    calls: number;
    input: number;
    output: number;
    cacheRead: number;
  }>;
  readonly byTool: ReadonlyArray<{ tool: string; calls: number }>;
  readonly byModel: ReadonlyArray<{
    model: string;
    cost: number;
    calls: number;
    input: number;
    output: number;
    cacheRead: number;
  }>;
  readonly byKind: ReadonlyArray<{ kind: string; cost: number; calls: number }>;
}

const TOOL_NAME_SQL = "substr(text, 1, instr(text || ' ', ' ') - 1)";

export const usage = async (sql: SqlDriver, days: number, now: number): Promise<UsageReport> => {
  const since = now - days * DAY;
  const byDay = (
    await rowsOrEmpty<{
      day: string;
      cost: number;
      calls: number;
      input: number;
      output: number;
      cache_read: number;
    }>(
      sql,
      `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, SUM(cost) AS cost, COUNT(*) AS calls,
              SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read
       FROM app_usage WHERE at >= ? GROUP BY day ORDER BY day`,
      since,
    )
  ).map(({ cache_read, ...rest }) => ({ ...rest, cacheRead: cache_read }));
  const byTool = await rowsOrEmpty<{ tool: string; calls: number }>(
    sql,
    `SELECT ${TOOL_NAME_SQL} AS tool, COUNT(*) AS calls
     FROM mem_messages WHERE kind = 'tool' AND date >= ? GROUP BY tool ORDER BY calls DESC LIMIT 12`,
    new Date(since).toISOString(),
  );
  const byModel = await rowsOrEmpty<{
    model: string;
    cost: number;
    calls: number;
    input: number;
    output: number;
    cache_read: number;
  }>(
    sql,
    `SELECT model, SUM(cost) AS cost, COUNT(*) AS calls, SUM(input) AS input, SUM(output) AS output,
            SUM(cache_read) AS cache_read
     FROM app_usage WHERE at >= ? GROUP BY model ORDER BY cost DESC`,
    since,
  );
  const byKind = await rowsOrEmpty<{ kind: string; cost: number; calls: number }>(
    sql,
    `SELECT kind, SUM(cost) AS cost, COUNT(*) AS calls FROM app_usage WHERE at >= ?
     GROUP BY kind ORDER BY cost DESC`,
    since,
  );
  return {
    byDay,
    byTool,
    byModel: byModel.map(({ cache_read, ...rest }) => ({ ...rest, cacheRead: cache_read })),
    byKind,
  };
};

export interface SkillRow {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly pinned: boolean;
  readonly useCount: number;
  readonly usedAt: number | null;
  readonly updated: number;
}

export const skills = async (sql: SqlDriver): Promise<SkillRow[]> =>
  (
    await rowsOrEmpty<{
      name: string;
      description: string;
      body: string;
      pinned: number;
      use_count: number;
      used_at: number | null;
      updated: number;
    }>(
      sql,
      `SELECT name, description, body, pinned, use_count, used_at, updated FROM app_skills ORDER BY name`,
    )
  ).map((skill) => ({
    name: skill.name,
    description: skill.description,
    body: skill.body,
    pinned: skill.pinned === 1,
    useCount: skill.use_count,
    usedAt: skill.used_at,
    updated: skill.updated,
  }));

export interface IntentRow {
  readonly id: number;
  readonly description: string;
  readonly triggers: ReadonlyArray<string>;
  readonly state: string;
  readonly fireCount: number;
  readonly maxFires: number;
  readonly cooldown: number;
  readonly expires: number;
  readonly lastFired: number | null;
}

const triggersOf = (json: string): string[] => {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

export const intents = async (sql: SqlDriver): Promise<IntentRow[]> =>
  (
    await rowsOrEmpty<{
      id: number;
      description: string;
      triggers: string;
      state: string;
      fire_count: number;
      max_fires: number;
      cooldown: number;
      expires: number;
      last_fired: number | null;
    }>(
      sql,
      `SELECT id, description, triggers, state, fire_count, max_fires, cooldown, expires, last_fired
       FROM app_intents ORDER BY id`,
    )
  ).map((intent) => ({
    id: intent.id,
    description: intent.description,
    triggers: triggersOf(intent.triggers),
    state: intent.state,
    fireCount: intent.fire_count,
    maxFires: intent.max_fires,
    cooldown: intent.cooldown,
    expires: intent.expires,
    lastFired: intent.last_fired,
  }));

export interface PolicyRow {
  readonly id: number;
  readonly match: string;
  readonly decision: string;
}

export const policies = async (sql: SqlDriver): Promise<PolicyRow[]> =>
  rowsOrEmpty<PolicyRow>(sql, `SELECT id, match, decision FROM app_policies ORDER BY id`);

export interface AuditRow {
  readonly at: number;
  readonly who: string;
  readonly action: string;
  readonly target: number;
  readonly ok: boolean;
}

export const audit = async (sql: SqlDriver): Promise<AuditRow[]> =>
  (
    await rowsOrEmpty<{
      at: number;
      who: string;
      action: string;
      target: number;
      ok: number;
    }>(sql, `SELECT at, who, action, target, ok FROM app_audit ORDER BY at DESC LIMIT 100`)
  ).map((r) => ({ ...r, ok: r.ok === 1 }));
