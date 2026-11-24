import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Replies to GET /admin/api/<page>
// ---------------------------------------------------------------------------

/** One agent as the channel picker lists it. `threadId` is the agent's slug. */
export const Channel = Schema.Struct({
  doName: Schema.String,
  threadId: Schema.String,
  name: Schema.String,
  lastActive: Schema.Finite,
});
export type Channel = typeof Channel.Type;

export const Overview = Schema.Struct({
  messages: Schema.Finite,
  nodes: Schema.Finite,
  viewLines: Schema.Finite,
  spend: Schema.Struct({
    last24h: Schema.Finite,
    last7d: Schema.Finite,
    total: Schema.Finite,
  }),
  settings: Schema.Record(Schema.String, Schema.String),
  turns: Schema.Array(Schema.Struct({ chatId: Schema.String, text: Schema.String })),
  approvals: Schema.Array(
    Schema.Struct({ id: Schema.Finite, summary: Schema.String, posted: Schema.Boolean }),
  ),
  schedules: Schema.Finite,
  daily: Schema.Array(Schema.Struct({ day: Schema.String, cost: Schema.Finite })),
  nextSchedule: Schema.NullOr(Schema.Finite),
});
export type Overview = typeof Overview.Type;

/** The kinds of message in the chat log, as the `kind` filter of the messages page takes them. */
export const MESSAGE_KINDS = ["user", "agent", "tool", "echo", "note"] as const;

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
export type Entry = typeof Entry.Type;

export const ViewLine = Schema.Struct({
  label: Schema.String,
  level: Schema.Finite,
  text: Schema.String,
  size: Schema.Finite,
});
export type ViewLine = typeof ViewLine.Type;

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
export type UsageReport = typeof UsageReport.Type;

export const ScheduleRow = Schema.Struct({
  id: Schema.Finite,
  spec: Schema.String,
  prompt: Schema.String,
  nextAt: Schema.Finite,
});
export type ScheduleRow = typeof ScheduleRow.Type;

export const Profile = Schema.Struct({
  about: Schema.String,
  rules: Schema.Array(Schema.String),
});
export type Profile = typeof Profile.Type;

export const SkillRow = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  pinned: Schema.Boolean,
  useCount: Schema.Finite,
  usedAt: Schema.NullOr(Schema.Finite),
  updated: Schema.Finite,
});
export type SkillRow = typeof SkillRow.Type;

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
export type IntentRow = typeof IntentRow.Type;

/** What a policy does with a call it matches. */
export const Decision = Schema.Literals(["allow", "ask", "deny"]);
export type Decision = typeof Decision.Type;

export const PolicyRow = Schema.Struct({
  id: Schema.Finite,
  match: Schema.String,
  decision: Decision,
});
export type PolicyRow = typeof PolicyRow.Type;

export const RunRow = Schema.Struct({
  id: Schema.Finite,
  scheduleId: Schema.Finite,
  status: Schema.String,
  started: Schema.Finite,
  finished: Schema.NullOr(Schema.Finite),
  output: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type RunRow = typeof RunRow.Type;

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
export type Summary = typeof Summary.Type;

export const AuditRow = Schema.Struct({
  at: Schema.Finite,
  who: Schema.String,
  action: Schema.String,
  target: Schema.Finite,
  ok: Schema.Boolean,
});
export type AuditRow = typeof AuditRow.Type;

export const ArtifactRow = Schema.Struct({
  name: Schema.String,
  token: Schema.String,
  version: Schema.Finite,
  contentType: Schema.String,
  updated: Schema.Finite,
  visibility: Schema.Literals(["public", "private"]),
  url: Schema.String,
});
export type ArtifactRow = typeof ArtifactRow.Type;

export const ArtifactSource = Schema.Struct({
  artifact: ArtifactRow,
  text: Schema.String,
  size: Schema.Finite,
});
export type ArtifactSource = typeof ArtifactSource.Type;

/** An agent as the Agents page shows it. `tools: null` is every tool. */
export const AgentRow = Schema.Struct({
  doName: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  role: Schema.String,
  persona: Schema.String,
  tools: Schema.NullOr(Schema.Array(Schema.String)),
  isDefault: Schema.Boolean,
  model: Schema.String,
  created: Schema.Finite,
  lastActive: Schema.Finite,
});
export type AgentRow = typeof AgentRow.Type;

/**
 * Every page `GET /admin/api/<page>` serves, with the reply it sends. The first four are
 * install-wide; the rest read one agent, named by `?c=<doName>`.
 */
export const Reads = {
  channels: Schema.Array(Channel),
  profile: Profile,
  agents: Schema.Array(AgentRow),
  summary: Schema.Array(Summary),
  overview: Overview,
  messages: Schema.Array(LogMessage),
  message: Entry,
  memory: Schema.Array(ViewLine),
  usage: UsageReport,
  schedules: Schema.Array(ScheduleRow),
  skills: Schema.Array(SkillRow),
  intents: Schema.Array(IntentRow),
  policies: Schema.Array(PolicyRow),
  runs: Schema.Array(RunRow),
  audit: Schema.Array(AuditRow),
  artifacts: Schema.Array(ArtifactRow),
  artifact: ArtifactSource,
} as const;
export type ReadPage = keyof typeof Reads;

// ---------------------------------------------------------------------------
// Bodies of POST /admin/api/...
// ---------------------------------------------------------------------------

export const ProfileInput = Schema.Struct({
  about: Schema.optionalKey(Schema.String),
  rules: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ProfileInput = typeof ProfileInput.Type;

export const SkillInput = Schema.Struct({
  action: Schema.optionalKey(Schema.Literals(["save", "delete"])),
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  pinned: Schema.optionalKey(Schema.Boolean),
});
export type SkillInput = typeof SkillInput.Type;

export const IntentInput = Schema.Struct({
  action: Schema.optionalKey(Schema.Literals(["save", "cancel"])),
  id: Schema.optionalKey(Schema.Finite),
  description: Schema.optionalKey(Schema.String),
  triggers: Schema.optionalKey(Schema.Array(Schema.String)),
  expires: Schema.optionalKey(Schema.Finite),
  maxFires: Schema.optionalKey(Schema.Finite),
  cooldownHours: Schema.optionalKey(Schema.Finite),
});
export type IntentInput = typeof IntentInput.Type;

export const PolicyInput = Schema.Struct({
  action: Schema.optionalKey(Schema.Literals(["save", "remove"])),
  id: Schema.optionalKey(Schema.Finite),
  match: Schema.optionalKey(Schema.String),
  decision: Schema.optionalKey(Decision),
});
export type PolicyInput = typeof PolicyInput.Type;

/** The four things an agent edit changes, each posted to its own path. */
export const AgentKind = Schema.Literals(["profile", "skills", "intents", "policies"]);
export type AgentKind = typeof AgentKind.Type;

/**
 * One agent edit as the dashboard builds it: the kind names the path, the rest is the body of
 * that kind's input.
 */
export const AgentEdit = Schema.Struct({
  ...ProfileInput.fields,
  ...SkillInput.fields,
  ...IntentInput.fields,
  ...PolicyInput.fields,
  kind: AgentKind,
  action: Schema.Literals(["save", "delete", "remove", "cancel"]),
});
export type AgentEdit = typeof AgentEdit.Type;

/** The body of a setting change. A missing or blank value clears the setting. */
export const SettingInput = Schema.Struct({ value: Schema.optionalKey(Schema.String) });
export type SettingInput = typeof SettingInput.Type;

/** The settings each agent keeps, each one overriding its install-wide default. */
export const SETTING_KEYS = ["model", "instructions", "timezone", "budget"] as const;
export const SettingKey = Schema.Literals(SETTING_KEYS);
export type SettingKey = typeof SettingKey.Type;

/** The body that publishes a new artifact. */
export const NewArtifact = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["html", "markdown"]),
  content: Schema.String,
});
export type NewArtifact = typeof NewArtifact.Type;

/** What the Agents form sends. `tools: null` is every tool. */
export const AgentManagement = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  role: Schema.String,
  persona: Schema.String,
  model: Schema.String,
  tools: Schema.NullOr(Schema.Array(Schema.String)),
});
export type AgentManagement = typeof AgentManagement.Type;

export const AgentOp = Schema.Literals(["create", "update", "delete"]);
export type AgentOp = typeof AgentOp.Type;

export const ArtifactAction = Schema.Literals(["public", "private", "delete"]);
export type ArtifactAction = typeof ArtifactAction.Type;

/** What the dashboard can do to a pending approval, a schedule, or a running turn. */
export const ActionKind = Schema.Literals(["approve", "deny", "cancel", "stop"]);
export type ActionKind = typeof ActionKind.Type;

// ---------------------------------------------------------------------------
// Replies to POST /admin/api/...
// ---------------------------------------------------------------------------

/** A refused or failed write. */
export const ErrorReply = Schema.Struct({ error: Schema.String });

/** A write that is done and says so in words for the dashboard to show. */
export const SavedReply = Schema.Struct({ ok: Schema.Literal(true), said: Schema.String });

/** An agent edit: saved, or refused with the reason. */
export const EditOutcome = Schema.Union([
  SavedReply,
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export type EditOutcome = typeof EditOutcome.Type;

/** A published artifact, with its public link. */
export const PublishedReply = Schema.Struct({ ok: Schema.Literal(true), url: Schema.String });

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Every write must carry this header with this value, which a cross-site form cannot send. */
export const CSRF_HEADER = "x-mizook-csrf";
export const CSRF_VALUE = "1";

export const API_ROOT = "/admin/api";

/** The paths the dashboard calls. Each matches one of `routes`. */
export const paths = {
  read: (page: ReadPage) => `${API_ROOT}/${page}`,
  stop: `${API_ROOT}/stop`,
  newAgent: `${API_ROOT}/agents`,
  agent: (slug: string, op: Exclude<AgentOp, "create">) =>
    `${API_ROOT}/agents/${encodeURIComponent(slug)}/${op}`,
  newArtifact: `${API_ROOT}/artifacts`,
  artifact: (name: string, action: ArtifactAction) =>
    `${API_ROOT}/artifacts/${encodeURIComponent(name)}/${action}`,
  edit: (kind: AgentKind) => `${API_ROOT}/${kind}`,
  setting: (key: SettingKey) => `${API_ROOT}/settings/${key}`,
  approval: (id: number, action: "approve" | "deny") => `${API_ROOT}/approvals/${id}/${action}`,
  cancelSchedule: (id: number) => `${API_ROOT}/schedules/${id}/cancel`,
} as const;

/** The paths the Worker answers, with the parts it reads captured. */
export const routes = {
  read: /^\/admin\/api\/([a-z]+)$/,
  agent: /^\/admin\/api\/agents\/([a-z][a-z0-9_]{1,31})\/(update|delete)$/,
  edit: /^\/admin\/api\/(profile|skills|intents|policies)$/,
  artifact: /^\/admin\/api\/artifacts\/([a-z0-9][a-z0-9._-]{0,60})\/(public|private|delete)$/,
  setting: /^\/admin\/api\/settings\/([a-z]+)$/,
  approvalOrSchedule:
    /^\/admin\/api\/(?:approvals\/(\d+)\/(approve|deny)|schedules\/(\d+)\/(cancel))$/,
} as const;
