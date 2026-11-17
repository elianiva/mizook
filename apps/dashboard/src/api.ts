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
    Schema.Struct({ day: Schema.String, cost: Schema.Finite, calls: Schema.Finite }),
  ),
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

export const ActionKind = Schema.Literals(["approve", "deny", "cancel"]);
export type ActionKind = typeof ActionKind.Type;

/** A write. The header and same-origin post are what the Worker checks besides the Access token. */
export const postAction = (
  channel: string,
  action: ActionKind,
  id: number,
): Effect.Effect<void, string> =>
  Effect.tryPromise({
    try: async () => {
      const resource = action === "cancel" ? "schedules" : "approvals";
      const url = `/admin/api/${resource}/${id}/${action}?c=${encodeURIComponent(channel)}`;
      const response = await fetch(url, { method: "POST", headers: { "x-mizook-csrf": "1" } });
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "It was already handled"
            : `Request failed (${response.status})`,
        );
      }
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });
