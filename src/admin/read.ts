import type { SqlDriver } from "@mizook/memory/sqlite";

/** Read-only views of one channel's SQLite, for the dashboard. A table that does not exist yet reads as empty. */
const rows = async <T>(sql: SqlDriver, text: string, ...params: unknown[]): Promise<T[]> => {
  try {
    return await sql.all<T>(text, ...params);
  } catch {
    return [];
  }
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A message in a list is cut here; open it for the rest. */
const PREVIEW = 600;

export interface Overview {
  readonly messages: number;
  readonly nodes: number;
  readonly viewLines: number;
  readonly spend: { readonly last24h: number; readonly last7d: number; readonly total: number };
  readonly settings: Record<string, string>;
  readonly turns: ReadonlyArray<{ chatId: string; text: string }>;
  readonly approvals: ReadonlyArray<{ id: number; summary: string; posted: boolean }>;
  readonly schedules: number;
}

const count = async (sql: SqlDriver, table: string) =>
  (await rows<{ n: number }>(sql, `SELECT COUNT(*) AS n FROM ${table}`))[0]?.n ?? 0;

const spentSince = async (sql: SqlDriver, since: number) =>
  (
    await rows<{ total: number | null }>(
      sql,
      `SELECT SUM(cost) AS total FROM app_usage WHERE at >= ?`,
      since,
    )
  )[0]?.total ?? 0;

export const overview = async (sql: SqlDriver, now: number): Promise<Overview> => {
  const views = (await rows<{ json: string }>(sql, `SELECT json FROM mem_views`))[0]?.json;
  const lines = views ? (JSON.parse(views) as { chat: { lines: unknown[] } }).chat.lines.length : 0;
  const settings = await rows<{ key: string; value: string }>(
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
      await rows<{ chat_id: string; text: string }>(sql, `SELECT chat_id, text FROM app_turns`)
    ).map((t) => ({ chatId: t.chat_id, text: t.text.slice(0, PREVIEW) })),
    approvals: (
      await rows<{ id: number; summary: string; posted: number }>(
        sql,
        `SELECT id, summary, posted FROM app_approvals ORDER BY id`,
      )
    ).map((a) => ({ id: a.id, summary: a.summary, posted: a.posted === 1 })),
    schedules:
      (
        await rows<{ n: number }>(sql, `SELECT COUNT(*) AS n FROM app_schedules WHERE active = 1`)
      )[0]?.n ?? 0,
  };
};

export interface LogMessage {
  readonly i: number;
  readonly kind: string;
  readonly text: string;
  readonly size: number;
  readonly date: string;
  /** The text was cut for the list. */
  readonly cut: boolean;
}

const KINDS = ["user", "agent", "tool", "echo", "note"];

/** Newest first. `before` is the id to page from; `q` is a plain substring. */
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
  const found = await rows<{ i: number; kind: string; text: string; size: number; date: string }>(
    sql,
    `SELECT i, kind, substr(text, 1, ${PREVIEW + 1}) AS text, size, date FROM mem_messages
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY i DESC LIMIT ?`,
    ...params,
    options.limit,
  );
  return found.map((m) => ({
    ...m,
    text: m.text.slice(0, PREVIEW),
    cut: m.text.length > PREVIEW || m.size > PREVIEW * 4,
  }));
};

export const message = async (sql: SqlDriver, i: number) =>
  (
    await rows<{ i: number; kind: string; text: string; size: number; date: string }>(
      sql,
      `SELECT i, kind, text, size, date FROM mem_messages WHERE i = ?`,
      i,
    )
  )[0];

export interface ViewLine {
  readonly label: string;
  readonly level: number;
  readonly text: string;
  readonly size: number;
}

/** The lines the next turn would see, oldest first, named as the agent names them: `id+n`. */
export const memoryView = async (sql: SqlDriver): Promise<ViewLine[]> => {
  const json = (await rows<{ json: string }>(sql, `SELECT json FROM mem_views`))[0]?.json;
  if (!json) return [];
  const lines = (JSON.parse(json) as { chat: { lines: Array<[number, number]> } }).chat.lines;
  const nodes = await rows<{ l: number; i: number; text: string; size: number }>(
    sql,
    `SELECT n.l, n.i, n.text, n.size FROM mem_nodes n`,
  );
  const byKey = new Map(nodes.map((n) => [`${n.l}:${n.i}`, n]));
  return lines.map(([l, i]) => {
    const node = byKey.get(`${l}:${i}`);
    return {
      label: `${i * 2 ** l}+${2 ** l}`,
      level: l,
      text: node?.text ?? "",
      size: node?.size ?? 0,
    };
  });
};

export interface UsageReport {
  readonly byDay: ReadonlyArray<{ day: string; cost: number; calls: number }>;
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

/** Spend over the last `days` days, by UTC day, model and kind of call. */
export const usage = async (sql: SqlDriver, days: number, now: number): Promise<UsageReport> => {
  const since = now - days * DAY;
  const byDay = await rows<{ day: string; cost: number; calls: number }>(
    sql,
    `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, SUM(cost) AS cost, COUNT(*) AS calls
     FROM app_usage WHERE at >= ? GROUP BY day ORDER BY day`,
    since,
  );
  const byModel = await rows<{
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
  const byKind = await rows<{ kind: string; cost: number; calls: number }>(
    sql,
    `SELECT kind, SUM(cost) AS cost, COUNT(*) AS calls FROM app_usage WHERE at >= ?
     GROUP BY kind ORDER BY cost DESC`,
    since,
  );
  return {
    byDay,
    byModel: byModel.map(({ cache_read, ...rest }) => ({ ...rest, cacheRead: cache_read })),
    byKind,
  };
};

export interface ScheduleRow {
  readonly id: number;
  readonly spec: string;
  readonly prompt: string;
  readonly nextAt: number;
}

export const schedules = async (sql: SqlDriver): Promise<ScheduleRow[]> =>
  (
    await rows<{ id: number; spec: string; prompt: string; next_at: number }>(
      sql,
      `SELECT id, spec, prompt, next_at FROM app_schedules WHERE active = 1 ORDER BY next_at, id`,
    )
  ).map((s) => ({ id: s.id, spec: s.spec, prompt: s.prompt, nextAt: s.next_at }));
