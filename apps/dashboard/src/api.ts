import { Effect, Schema } from "effect";
import { Query } from "foldkit/experimental";

export const Channel = Schema.Struct({
  doName: Schema.String,
  threadId: Schema.String,
  name: Schema.String,
  lastActive: Schema.Finite,
});

const Spend = Schema.Struct({
  last24h: Schema.Finite,
  last7d: Schema.Finite,
  total: Schema.Finite,
});

export const Overview = Schema.Struct({
  messages: Schema.Finite,
  nodes: Schema.Finite,
  viewLines: Schema.Finite,
  spend: Spend,
  settings: Schema.Record(Schema.String, Schema.String),
  turns: Schema.Array(Schema.Struct({ chatId: Schema.String, text: Schema.String })),
  approvals: Schema.Array(
    Schema.Struct({ id: Schema.Finite, summary: Schema.String, posted: Schema.Boolean }),
  ),
  schedules: Schema.Finite,
});

export const LogMessage = Schema.Struct({
  i: Schema.Finite,
  kind: Schema.String,
  text: Schema.String,
  size: Schema.Finite,
  date: Schema.String,
  cut: Schema.Boolean,
});
export type LogMessage = typeof LogMessage.Type;

export const Entry = Schema.Struct({
  i: Schema.Finite,
  kind: Schema.String,
  text: Schema.String,
  size: Schema.Finite,
  date: Schema.String,
});

export const ViewLine = Schema.Struct({
  label: Schema.String,
  level: Schema.Finite,
  text: Schema.String,
  size: Schema.Finite,
});

export const UsageReport = Schema.Struct({
  byDay: Schema.Array(
    Schema.Struct({
      day: Schema.String,
      cost: Schema.Finite,
      calls: Schema.Finite,
      input: Schema.Finite,
      output: Schema.Finite,
      cacheRead: Schema.Finite,
    }),
  ),
  byTool: Schema.Array(Schema.Struct({ tool: Schema.String, calls: Schema.Finite })),
  byModel: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      cost: Schema.Finite,
      calls: Schema.Finite,
      input: Schema.Finite,
      output: Schema.Finite,
      cacheRead: Schema.Finite,
    }),
  ),
  byKind: Schema.Array(
    Schema.Struct({ kind: Schema.String, cost: Schema.Finite, calls: Schema.Finite }),
  ),
});

export const ScheduleRow = Schema.Struct({
  id: Schema.Finite,
  spec: Schema.String,
  prompt: Schema.String,
  nextAt: Schema.Finite,
});

const fetchJson = <A, I>(
  schema: Schema.Codec<A, I>,
  path: string,
  params: Readonly<Record<string, string | number>>,
): Effect.Effect<A, string> =>
  Effect.tryPromise({
    try: async () => {
      const url = new URL(`/admin/api/${path}`, location.origin);
      Object.entries(params).forEach(([key, value]) => {
        if (value !== "") {
          url.searchParams.set(key, String(value));
        }
      });
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) {
        throw new Error(
          response.status === 404 ? "Not found" : `Request failed (${response.status})`,
        );
      }
      return response.json() as Promise<unknown>;
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(() => "The server sent something unexpected"),
      ),
    ),
  );

const channelArgs = { channel: Schema.String };

export const channelsQuery = Query.define({
  name: "Channels",
  data: Schema.Array(Channel),
  error: Schema.String,
  execute: fetchJson(Schema.Array(Channel), "channels", {}),
});

export const overviewQuery = Query.define({
  name: "Overview",
  args: channelArgs,
  data: Overview,
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Overview, "overview", { c: channel }),
});

export const logQuery = Query.define({
  name: "Log",
  args: { channel: Schema.String, kind: Schema.String, q: Schema.String, before: Schema.String },
  data: Schema.Array(LogMessage),
  error: Schema.String,
  execute: ({ channel, kind, q, before }) =>
    fetchJson(Schema.Array(LogMessage), "messages", { c: channel, kind, q, before }),
});

export const entryQuery = Query.define({
  name: "Entry",
  args: { channel: Schema.String, entryId: Schema.Finite },
  data: Entry,
  error: Schema.String,
  execute: ({ channel, entryId }) => fetchJson(Entry, "message", { c: channel, i: entryId }),
});

export const memoryQuery = Query.define({
  name: "Memory",
  args: channelArgs,
  data: Schema.Array(ViewLine),
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Schema.Array(ViewLine), "memory", { c: channel }),
});

export const usageQuery = Query.define({
  name: "Usage",
  args: { channel: Schema.String, days: Schema.Finite },
  data: UsageReport,
  error: Schema.String,
  execute: ({ channel, days }) => fetchJson(UsageReport, "usage", { c: channel, days }),
});

export const schedulesQuery = Query.define({
  name: "Schedules",
  args: channelArgs,
  data: Schema.Array(ScheduleRow),
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Schema.Array(ScheduleRow), "schedules", { c: channel }),
});

export const Summary = Schema.Struct({
  doName: Schema.String,
  name: Schema.String,
  lastActive: Schema.Finite,
  messages: Schema.Finite,
  spend24h: Schema.Finite,
  spend7d: Schema.Finite,
  pending: Schema.Finite,
  approvals: Schema.Finite,
  schedules: Schema.Finite,
  budget: Schema.Finite,
});

export const AuditRow = Schema.Struct({
  at: Schema.Finite,
  who: Schema.String,
  action: Schema.String,
  target: Schema.Finite,
  ok: Schema.Boolean,
});

export const summaryQuery = Query.define({
  name: "Summary",
  data: Schema.Array(Summary),
  error: Schema.String,
  execute: fetchJson(Schema.Array(Summary), "summary", {}),
});

export const auditQuery = Query.define({
  name: "Audit",
  args: channelArgs,
  data: Schema.Array(AuditRow),
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Schema.Array(AuditRow), "audit", { c: channel }),
});

/** The newest few messages, for the overview. The Log page pages through the rest. */
export const recentQuery = Query.define({
  name: "Recent",
  args: channelArgs,
  data: Schema.Array(LogMessage),
  error: Schema.String,
  execute: ({ channel }) =>
    fetchJson(Schema.Array(LogMessage), "messages", { c: channel, limit: 8 }),
});

export const ActionKind = Schema.Literals(["approve", "deny", "cancel", "stop"]);
export type ActionKind = typeof ActionKind.Type;

export const SettingKey = Schema.Literals(["model", "budget", "timezone", "instructions"]);
export type SettingKey = typeof SettingKey.Type;

/** A write. The header and same-origin post are what the Worker checks besides the Access token. */
const write = (path: string, channel: string, body?: unknown): Effect.Effect<unknown, string> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`/admin/api/${path}?c=${encodeURIComponent(channel)}`, {
        method: "POST",
        headers: { "x-mizook-csrf": "1", "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const reply = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "It was already handled"
            : (reply.error ?? `Request failed (${response.status})`),
        );
      }
      return reply;
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });

export const postAction = (
  channel: string,
  action: ActionKind,
  id: number,
): Effect.Effect<void, string> =>
  write(
    action === "stop"
      ? "stop"
      : `${action === "cancel" ? "schedules" : "approvals"}/${id}/${action}`,
    channel,
  ).pipe(Effect.asVoid);

/** An empty value puts the setting back to its default. Gives the channel's reply. */
export const postSetting = (
  channel: string,
  key: SettingKey,
  value: string,
): Effect.Effect<string, string> =>
  write(`settings/${key}`, channel, { value }).pipe(
    Effect.map((reply) => String((reply as { said?: string }).said ?? "Saved.")),
  );
