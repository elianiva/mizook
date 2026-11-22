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
  daily: Schema.Array(Schema.Struct({ day: Schema.String, cost: Schema.Finite })),
  nextSchedule: Schema.NullOr(Schema.Finite),
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

export const Profile = Schema.Struct({
  about: Schema.String,
  rules: Schema.Array(Schema.String),
});

export const SkillRow = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  pinned: Schema.Boolean,
  useCount: Schema.Finite,
  usedAt: Schema.NullOr(Schema.Finite),
  updated: Schema.Finite,
});

export const IntentRow = Schema.Struct({
  id: Schema.Finite,
  description: Schema.String,
  triggers: Schema.Array(Schema.String),
  state: Schema.String,
  fireCount: Schema.Finite,
  maxFires: Schema.Finite,
  cooldown: Schema.Finite,
  expires: Schema.Finite,
  lastFired: Schema.NullOr(Schema.Finite),
});

export const PolicyRow = Schema.Struct({
  id: Schema.Finite,
  match: Schema.String,
  decision: Schema.String,
});

export const RunRow = Schema.Struct({
  id: Schema.Finite,
  scheduleId: Schema.Finite,
  status: Schema.String,
  started: Schema.Finite,
  finished: Schema.NullOr(Schema.Finite),
  output: Schema.String,
  error: Schema.NullOr(Schema.String),
});

export const AgentKind = Schema.Literals(["profile", "skills", "intents", "policies"]);
export type AgentKind = typeof AgentKind.Type;

export const AgentEdit = Schema.Struct({
  kind: AgentKind,
  action: Schema.Literals(["save", "delete", "remove", "cancel"]),
  id: Schema.optionalKey(Schema.Finite),
  about: Schema.optionalKey(Schema.String),
  rules: Schema.optionalKey(Schema.Array(Schema.String)),
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  pinned: Schema.optionalKey(Schema.Boolean),
  triggers: Schema.optionalKey(Schema.Array(Schema.String)),
  expires: Schema.optionalKey(Schema.Finite),
  maxFires: Schema.optionalKey(Schema.Finite),
  cooldownHours: Schema.optionalKey(Schema.Finite),
  match: Schema.optionalKey(Schema.String),
  decision: Schema.optionalKey(Schema.String),
});
export type AgentEdit = typeof AgentEdit.Type;

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

export const profileQuery = Query.define({
  name: "Profile",
  data: Profile,
  error: Schema.String,
  execute: fetchJson(Profile, "profile", {}),
});

export const skillsQuery = Query.define({
  name: "Skills",
  args: channelArgs,
  data: Schema.Array(SkillRow),
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Schema.Array(SkillRow), "skills", { c: channel }),
});

export const intentsQuery = Query.define({
  name: "Intents",
  args: channelArgs,
  data: Schema.Array(IntentRow),
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Schema.Array(IntentRow), "intents", { c: channel }),
});

export const policiesQuery = Query.define({
  name: "Policies",
  args: channelArgs,
  data: Schema.Array(PolicyRow),
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Schema.Array(PolicyRow), "policies", { c: channel }),
});

export const runsQuery = Query.define({
  name: "Runs",
  args: channelArgs,
  data: Schema.Array(RunRow),
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Schema.Array(RunRow), "runs", { c: channel, limit: 25 }),
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

export const ArtifactRow = Schema.Struct({
  name: Schema.String,
  token: Schema.String,
  version: Schema.Finite,
  contentType: Schema.String,
  updated: Schema.Finite,
  visibility: Schema.Literals(["public", "private"]),
  url: Schema.String,
});

export const ArtifactSource = Schema.Struct({
  artifact: ArtifactRow,
  text: Schema.String,
  size: Schema.Finite,
});

export const artifactsQuery = Query.define({
  name: "Artifacts",
  args: channelArgs,
  data: Schema.Array(ArtifactRow),
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Schema.Array(ArtifactRow), "artifacts", { c: channel }),
});

export const artifactQuery = Query.define({
  name: "Artifact",
  args: { channel: Schema.String, name: Schema.String },
  data: ArtifactSource,
  error: Schema.String,
  execute: ({ channel, name }) => fetchJson(ArtifactSource, "artifact", { c: channel, name }),
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

const OVERVIEW_RECENT_MESSAGE_COUNT = 8;

export const recentQuery = Query.define({
  name: "Recent",
  args: channelArgs,
  data: Schema.Array(LogMessage),
  error: Schema.String,
  execute: ({ channel }) =>
    fetchJson(Schema.Array(LogMessage), "messages", {
      c: channel,
      limit: OVERVIEW_RECENT_MESSAGE_COUNT,
    }),
});

export const ActionKind = Schema.Literals(["approve", "deny", "cancel", "stop"]);
export type ActionKind = typeof ActionKind.Type;

export const ArtifactAction = Schema.Literals(["public", "private", "delete"]);
export type ArtifactAction = typeof ArtifactAction.Type;

export const SettingKey = Schema.Literals(["model", "budget", "timezone", "instructions"]);
export type SettingKey = typeof SettingKey.Type;

const CSRF_HEADER = { "x-mizook-csrf": "1" };
const HTTP_CONFLICT = 409;

const postSameOrigin = (
  path: string,
  channel: string,
  body?: unknown,
): Effect.Effect<unknown, string> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`/admin/api/${path}?c=${encodeURIComponent(channel)}`, {
        method: "POST",
        headers: {
          ...CSRF_HEADER,
          "content-type": "application/json",
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const reply = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(
          response.status === HTTP_CONFLICT
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
  postSameOrigin(
    action === "stop"
      ? "stop"
      : `${action === "cancel" ? "schedules" : "approvals"}/${id}/${action}`,
    channel,
  ).pipe(Effect.asVoid);

const channelReplyOf = (reply: unknown): string =>
  String((reply as { said?: string }).said ?? "Saved.");

const publicLinkOf = (reply: unknown): string => String((reply as { url?: string }).url ?? "");

export const postNewArtifact = (
  channel: string,
  draft: { name: string; kind: string; content: string },
): Effect.Effect<string, string> =>
  postSameOrigin("artifacts", channel, draft).pipe(Effect.map(publicLinkOf));

export const postArtifact = (
  channel: string,
  name: string,
  action: ArtifactAction,
): Effect.Effect<void, string> =>
  postSameOrigin(`artifacts/${encodeURIComponent(name)}/${action}`, channel).pipe(Effect.asVoid);

export const postSetting = (
  channel: string,
  key: SettingKey,
  value: string,
): Effect.Effect<string, string> =>
  postSameOrigin(`settings/${key}`, channel, { value: value }).pipe(Effect.map(channelReplyOf));

export const postAgent = (channel: string, edit: AgentEdit): Effect.Effect<string, string> => {
  const { kind, ...body } = edit;
  return postSameOrigin(kind, channel, body).pipe(Effect.map(channelReplyOf));
};
