import { Array, Duration, Effect, Option, Predicate, Record, Schema, Stream, pipe } from "effect";
import { AsyncData, Command, Runtime, Subscription, Update } from "foldkit";
import * as Dom from "foldkit/dom";
import { swipeDrawer } from "@mizook/ui/swipe";
import { Machine } from "foldkit/experimental";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import { type Url, toString as urlToString } from "foldkit/url";

import {
  ActionKind,
  AgentEdit,
  AgentKind,
  AgentManagement,
  AgentOp,
  AgentRow,
  Channel,
  agentsQuery,
  channelKey,
  IntentRow,
  Overview,
  PolicyRow,
  Profile,
  ScheduleRow,
  SkillRow,
  ArtifactRow,
  ArtifactAction,
  artifactQuery,
  artifactsQuery,
  postAgent,
  postArtifact,
  postManagedAgent,
  postNewArtifact,
  SettingKey,
  auditQuery,
  channelsQuery,
  entryQuery,
  intentsQuery,
  logQuery,
  memoryQuery,
  overviewQuery,
  policiesQuery,
  postAction,
  postSetting,
  profileQuery,
  recentQuery,
  runsQuery,
  skillsQuery,
  summaryQuery,
  schedulesQuery,
  usageQuery,
} from "./api.ts";
import { AgentForm, OpenAgentForm, emptyAgentForm, agentFormReady, managementOf } from "./forms.ts";
import { Message } from "./message.ts";
import { patch, patchKeyed } from "./optimistic.ts";
import { Model } from "./model.ts";
import { NavState } from "./nav.ts";
import { Confirmation, isArmed } from "./confirmation.ts";
import { GO_KEYS, matches, sections } from "./palette.ts";
import { PaletteState, paletteMachine } from "./palette-machine.ts";
import {
  AppRoute,
  daysOf,
  routeChannel,
  routeHref,
  routeOnChannel,
  textOf,
  urlToAppRoute,
} from "./route.ts";

const OVERVIEW_REFRESH = Duration.seconds(10);
const NOTICE_FOR = Duration.seconds(6);
const ARMED_FOR = Duration.seconds(4);

const ExpireNotice = Command.define("ExpireNotice", {
  args: { text: Schema.String },
  messages: [Message.ExpiredNotice],
  execute: ({ text }) => Effect.sleep(NOTICE_FOR).pipe(Effect.as(Message.ExpiredNotice({ text }))),
});

const ExpireArmed = Command.define("ExpireArmed", {
  args: { key: Schema.String },
  messages: [Message.ExpiredArmed],
  execute: ({ key }) => Effect.sleep(ARMED_FOR).pipe(Effect.as(Message.ExpiredArmed({ key }))),
});

/** Focuses an element once the next frame has drawn it. */
const FocusAfterPaint = Command.define("FocusAfterPaint", {
  args: { selector: Schema.String },
  messages: [Message.CompletedFocus],
  execute: ({ selector }) =>
    Effect.callback<void>((resume) => {
      requestAnimationFrame(() => resume(Effect.void));
    }).pipe(
      Effect.andThen(Dom.focus(selector)),
      Effect.as(Message.CompletedFocus()),
      Effect.orElseSucceed(() => Message.CompletedFocus()),
    ),
});

const goTo = (model: Model, href: string): UpdateReturn => ({
  model,
  commands: [NavigateInternal({ url: href })],
});

export const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
});

const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
});

const PostAction = Command.define("PostAction", {
  args: { channel: Schema.String, action: ActionKind, id: Schema.Finite },
  messages: [Message.SucceededAction, Message.FailedAction],
  execute: ({ channel, action, id }) =>
    postAction(channel, action, id).pipe(
      Effect.as(Message.SucceededAction()),
      Effect.catch((reason) => Effect.succeed(Message.FailedAction({ reason }))),
    ),
});

const PostArtifact = Command.define("PostArtifact", {
  args: { channel: Schema.String, name: Schema.String, action: ArtifactAction },
  messages: [Message.SucceededAction, Message.FailedAction],
  execute: ({ channel, name, action }) =>
    postArtifact(channel, name, action).pipe(
      Effect.as(Message.SucceededAction()),
      Effect.catch((reason) => Effect.succeed(Message.FailedAction({ reason }))),
    ),
});

const PostNewArtifact = Command.define("PostNewArtifact", {
  args: {
    channel: Schema.String,
    name: Schema.String,
    kind: Schema.String,
    content: Schema.String,
  },
  messages: [Message.SucceededPublish, Message.FailedPublish],
  execute: ({ channel, name, kind, content }) =>
    postNewArtifact(channel, { name, kind, content }).pipe(
      Effect.map((url) => Message.SucceededPublish({ url })),
      Effect.catch((reason) =>
        Effect.succeed(Message.FailedPublish({ reason, name, kind, content })),
      ),
    ),
});

const SaveSetting = Command.define("SaveSetting", {
  args: { channel: Schema.String, key: SettingKey, value: Schema.String },
  messages: [Message.SucceededAction, Message.FailedSetting],
  execute: ({ channel, key, value }) =>
    postSetting(channel, key, value).pipe(
      Effect.as(Message.SucceededAction()),
      Effect.catch((reason) => Effect.succeed(Message.FailedSetting({ reason, key, value }))),
    ),
});

const PostAgent = Command.define("PostAgent", {
  args: { channel: Schema.String, edit: AgentEdit, editor: OpenAgentForm },
  messages: [Message.SucceededAction, Message.FailedAgentEdit],
  execute: ({ channel, edit, editor }) =>
    postAgent(channel, edit).pipe(
      Effect.as(Message.SucceededAction()),
      Effect.catch((reason) => Effect.succeed(Message.FailedAgentEdit({ reason, editor }))),
    ),
});

const PostManagedAgent = Command.define("PostManagedAgent", {
  args: {
    op: AgentOp,
    slug: Schema.String,
    body: Schema.NullOr(AgentManagement),
    form: Schema.Option(AgentForm),
  },
  messages: [Message.SucceededAction, Message.FailedAgentManage],
  execute: ({ op, slug, body, form }) =>
    postManagedAgent(op, slug, body ?? undefined).pipe(
      Effect.as(Message.SucceededAction()),
      Effect.catch((reason) => Effect.succeed(Message.FailedAgentManage({ reason, form }))),
    ),
});

const channels = channelsQuery.lift<Model, Message>({
  parentField: "channels",
  toParentMessage: (message) => Message.GotChannelsMessage({ message }),
});
const agents = agentsQuery.lift<Model, Message>({
  parentField: "agents",
  toParentMessage: (message) => Message.GotAgentsMessage({ message }),
});
const overview = overviewQuery.lift<Model, Message>({
  parentField: "overview",
  toParentMessage: (message) => Message.GotOverviewMessage({ message }),
});
const log = logQuery.lift<Model, Message>({
  parentField: "log",
  toParentMessage: (message) => Message.GotLogMessage({ message }),
});
const entry = entryQuery.lift<Model, Message>({
  parentField: "entry",
  toParentMessage: (message) => Message.GotEntryMessage({ message }),
});
const memory = memoryQuery.lift<Model, Message>({
  parentField: "memory",
  toParentMessage: (message) => Message.GotMemoryMessage({ message }),
});
const usage = usageQuery.lift<Model, Message>({
  parentField: "usage",
  toParentMessage: (message) => Message.GotUsageMessage({ message }),
});
const summary = summaryQuery.lift<Model, Message>({
  parentField: "summary",
  toParentMessage: (message) => Message.GotSummaryMessage({ message }),
});
const audit = auditQuery.lift<Model, Message>({
  parentField: "audit",
  toParentMessage: (message) => Message.GotAuditMessage({ message }),
});
const artifacts = artifactsQuery.lift<Model, Message>({
  parentField: "artifacts",
  toParentMessage: (message) => Message.GotArtifactsMessage({ message }),
});
const artifact = artifactQuery.lift<Model, Message>({
  parentField: "artifact",
  toParentMessage: (message) => Message.GotArtifactMessage({ message }),
});
const recent = recentQuery.lift<Model, Message>({
  parentField: "recent",
  toParentMessage: (message) => Message.GotRecentMessage({ message }),
});
const schedules = schedulesQuery.lift<Model, Message>({
  parentField: "schedules",
  toParentMessage: (message) => Message.GotSchedulesMessage({ message }),
});
const profile = profileQuery.lift<Model, Message>({
  parentField: "profile",
  toParentMessage: (message) => Message.GotProfileMessage({ message }),
});
const skills = skillsQuery.lift<Model, Message>({
  parentField: "skills",
  toParentMessage: (message) => Message.GotSkillsMessage({ message }),
});
const intents = intentsQuery.lift<Model, Message>({
  parentField: "intents",
  toParentMessage: (message) => Message.GotIntentsMessage({ message }),
});
const policies = policiesQuery.lift<Model, Message>({
  parentField: "policies",
  toParentMessage: (message) => Message.GotPoliciesMessage({ message }),
});
const runs = runsQuery.lift<Model, Message>({
  parentField: "runs",
  toParentMessage: (message) => Message.GotRunsMessage({ message }),
});

export const currentChannel = (model: Model): Option.Option<string> =>
  Option.orElse(routeChannel(model.route), () =>
    pipe(
      AsyncData.getData(channelsQuery.read(model.channels)),
      Option.flatMap(Array.head),
      Option.map(({ doName }) => doName),
    ),
  );

type Editor = {
  readonly kind: AgentKind;
  readonly id: string;
  readonly fields: { readonly [key: string]: string };
};

const dateField = (at: number): string => new Date(at).toISOString().slice(0, 10);

const defaultFields = (kind: AgentKind): { readonly [key: string]: string } =>
  kind === "profile"
    ? { about: "", rules: "" }
    : kind === "skills"
      ? { name: "", description: "", body: "", pinned: "0" }
      : kind === "intents"
        ? {
            description: "",
            triggers: "",
            expires: dateField(Date.now() + 90 * 86_400_000),
            maxFires: "3",
            cooldownHours: "24",
          }
        : { match: "", decision: "ask" };

const fieldsFor = (
  model: Model,
  kind: AgentKind,
  id: string,
): { readonly [key: string]: string } | undefined => {
  if (kind === "profile") {
    return Option.match(AsyncData.getData(profileQuery.read(model.profile)), {
      onNone: () => undefined,
      onSome: (profile) => ({ about: profile.about, rules: profile.rules.join("\n") }),
    });
  }
  const channel = currentChannel(model);
  if (Option.isNone(channel)) return undefined;
  if (kind === "skills") {
    const rows = Option.getOrElse(
      AsyncData.getData(skillsQuery.read(model.skills, { channel: channel.value })),
      () => [],
    );
    const row = rows.find((item) => item.name === id);
    return row
      ? {
          name: row.name,
          description: row.description,
          body: row.body,
          pinned: row.pinned ? "1" : "0",
        }
      : defaultFields(kind);
  }
  if (kind === "intents") {
    const rows = Option.getOrElse(
      AsyncData.getData(intentsQuery.read(model.intents, { channel: channel.value })),
      () => [],
    );
    const row = rows.find((item) => String(item.id) === id);
    return row
      ? {
          description: row.description,
          triggers: row.triggers.join(", "),
          expires: dateField(row.expires),
          maxFires: String(row.maxFires),
          cooldownHours: String(row.cooldown / 3_600_000),
        }
      : defaultFields(kind);
  }
  const rows = Option.getOrElse(
    AsyncData.getData(policiesQuery.read(model.policies, { channel: channel.value })),
    () => [],
  );
  const row = rows.find((item) => String(item.id) === id);
  return row ? { match: row.match, decision: row.decision } : defaultFields(kind);
};

const openEditor = (model: Model, kind: AgentKind, id: string): UpdateReturn => {
  const fields = fieldsFor(model, kind, id);
  if (!fields) return { model };
  return {
    model: modifyFields(model, {
      editor: () => Option.some<Editor>({ kind, id, fields }),
      armed: () => Confirmation.Resting(),
      notice: () => Option.none(),
    }),
  };
};

const triggersOf = (text: string): string[] =>
  text
    .split(/[\n,]+/)
    .map((trigger) => trigger.trim())
    .filter((trigger) => trigger !== "");

const editOf = (editor: Editor): AgentEdit | undefined => {
  const fields = editor.fields;
  switch (editor.kind) {
    case "profile":
      return {
        kind: "profile",
        action: "save",
        about: fields.about ?? "",
        rules: (fields.rules ?? "")
          .split("\n")
          .map((rule) => rule.trim())
          .filter((rule) => rule !== ""),
      };
    case "skills":
      return {
        kind: "skills",
        action: "save",
        name: (editor.id || fields.name || "").trim(),
        description: fields.description ?? "",
        body: fields.body ?? "",
      };
    case "intents": {
      const expires = Date.parse(`${fields.expires ?? ""}T23:59:59.999Z`);
      return {
        kind: "intents",
        action: "save",
        ...(editor.id === "" ? {} : { id: Number(editor.id) }),
        description: fields.description ?? "",
        triggers: triggersOf(fields.triggers ?? ""),
        expires: Number.isFinite(expires) ? expires : 0,
        maxFires: Number(fields.maxFires ?? ""),
        cooldownHours: Number(fields.cooldownHours ?? ""),
      };
    }
    case "policies":
      return {
        kind: "policies",
        action: "save",
        ...(editor.id === "" ? {} : { id: Number(editor.id) }),
        match: fields.match ?? "",
        decision: fields.decision ?? "ask",
      };
  }
};

const removalOf = (kind: AgentKind, id: string): AgentEdit | undefined =>
  kind === "skills"
    ? { kind: "skills", action: "delete", name: id }
    : kind === "intents"
      ? { kind: "intents", action: "cancel", id: Number(id) }
      : kind === "policies"
        ? { kind: "policies", action: "remove", id: Number(id) }
        : undefined;

type UpdateReturn = Update.Return<Model, Message>;
type Step = Update.Step<Model, Message>;

const draftsOf = (route: AppRoute) =>
  AppRoute.match<{ draftKind: string; draftSearch: string }>(route, {
    Overview: () => ({ draftKind: "", draftSearch: "" }),
    Log: ({ kind, q }) => ({ draftKind: textOf(kind), draftSearch: textOf(q) }),
    Entry: () => ({ draftKind: "", draftSearch: "" }),
    Memory: () => ({ draftKind: "", draftSearch: "" }),
    Usage: () => ({ draftKind: "", draftSearch: "" }),
    Schedules: () => ({ draftKind: "", draftSearch: "" }),
    Agent: () => ({ draftKind: "", draftSearch: "" }),
    Agents: () => ({ draftKind: "", draftSearch: "" }),
    Profile: () => ({ draftKind: "", draftSearch: "" }),
    Runs: () => ({ draftKind: "", draftSearch: "" }),
    Settings: () => ({ draftKind: "", draftSearch: "" }),
    Audit: () => ({ draftKind: "", draftSearch: "" }),
    Artifacts: () => ({ draftKind: "", draftSearch: "" }),
    NotFound: () => ({ draftKind: "", draftSearch: "" }),
  });

const setRoute =
  (route: AppRoute): Step =>
  (model) => {
    const drafts = draftsOf(route);
    return {
      model: modifyFields(model, {
        route: () => route,
        nav: () => NavState.Closed(),
        armed: () => Confirmation.Resting(),
        editor: () => Option.none(),
        agentForm: () => Option.none(),
        notice: () => Option.none(),
        draftKind: () => drafts.draftKind,
        draftSearch: () => drafts.draftSearch,
      }),
    };
  };

const loadChannels: Step = (model) => channels.loadIfMissing(model);

const loadRoute: Step = (model) =>
  Option.match(currentChannel(model), {
    onNone: () => ({ model }),
    onSome: (channel) =>
      AppRoute.match<UpdateReturn>(model.route, {
        Overview: () =>
          Update.combine(model, [
            (stepModel) => overview.revalidateOrLoad(stepModel, { channel }),
            (stepModel) => recent.revalidateOrLoad(stepModel, { channel }),
            (stepModel) => summary.revalidateOrLoad(stepModel),
          ]),
        Log: ({ kind, q, before }) =>
          log.revalidateOrLoad(model, {
            channel,
            kind: textOf(kind),
            q: textOf(q),
            before: textOf(before),
          }),
        Entry: ({ entryId }) => entry.loadIfMissing(model, { channel, entryId }),
        Memory: () => memory.revalidateOrLoad(model, { channel }),
        Usage: ({ days }) => usage.revalidateOrLoad(model, { channel, days: daysOf(days) }),
        Schedules: () => schedules.revalidateOrLoad(model, { channel }),
        Profile: () => profile.revalidateOrLoad(model),
        Agent: () =>
          Update.combine(model, [
            (stepModel) => skills.revalidateOrLoad(stepModel, { channel }),
            (stepModel) => intents.revalidateOrLoad(stepModel, { channel }),
            (stepModel) => policies.revalidateOrLoad(stepModel, { channel }),
          ]),
        Agents: () => agents.revalidateOrLoad(model),
        Runs: () => runs.revalidateOrLoad(model, { channel }),
        Settings: () => overview.revalidateOrLoad(model, { channel }),
        Audit: () => audit.revalidateOrLoad(model, { channel }),
        Artifacts: ({ name }) =>
          Update.combine(model, [
            (stepModel) => artifacts.revalidateOrLoad(stepModel, { channel }),
            (stepModel) =>
              Option.match(name, {
                onNone: () => ({ model: stepModel }),
                onSome: (value) => artifact.revalidateOrLoad(stepModel, { channel, name: value }),
              }),
          ]),
        NotFound: () => ({ model }),
      }),
  });

type OverviewData = typeof Overview.Type;
type SkillData = typeof SkillRow.Type;
type IntentData = typeof IntentRow.Type;
type PolicyData = typeof PolicyRow.Type;
type ScheduleData = typeof ScheduleRow.Type;
type ArtifactData = typeof ArtifactRow.Type;
type ProfileData = typeof Profile.Type;
type ChannelData = typeof Channel.Type;

/**
 * Optimistic writes: each helper changes what the page shows before the server answers.
 * The command that follows refetches either way, so the server's answer settles the value
 * and a refused write rolls back on its own.
 */
const onOverview = (model: Model, channel: string, change: (o: OverviewData) => OverviewData) =>
  modifyFields(model, {
    overview: (query) => patchKeyed<OverviewData>()(query, channelKey({ channel }), change),
  });
const onSchedules = (
  model: Model,
  channel: string,
  change: (rows: ReadonlyArray<ScheduleData>) => ReadonlyArray<ScheduleData>,
) =>
  modifyFields(model, {
    schedules: (query) =>
      patchKeyed<ReadonlyArray<ScheduleData>>()(query, channelKey({ channel }), change),
  });
const onArtifacts = (
  model: Model,
  channel: string,
  change: (rows: ReadonlyArray<ArtifactData>) => ReadonlyArray<ArtifactData>,
) =>
  modifyFields(model, {
    artifacts: (query) =>
      patchKeyed<ReadonlyArray<ArtifactData>>()(query, channelKey({ channel }), change),
  });
const onAgents = (
  model: Model,
  change: (rows: ReadonlyArray<AgentRow>) => ReadonlyArray<AgentRow>,
) => modifyFields(model, { agents: (query) => patch<ReadonlyArray<AgentRow>>()(query, change) });
const onChannels = (
  model: Model,
  change: (rows: ReadonlyArray<ChannelData>) => ReadonlyArray<ChannelData>,
) =>
  modifyFields(model, {
    channels: (query) => patch<ReadonlyArray<ChannelData>>()(query, change),
  });

const withAction = (model: Model, channel: string, action: ActionKind, id: number): Model => {
  if (action === "approve" || action === "deny")
    return onOverview(model, channel, (o) => ({
      ...o,
      approvals: o.approvals.filter((approval) => approval.id !== id),
    }));
  if (action === "stop") return onOverview(model, channel, (o) => ({ ...o, turns: [] }));
  return onOverview(
    onSchedules(model, channel, (rows) => rows.filter((row) => row.id !== id)),
    channel,
    (o) => ({ ...o, schedules: Math.max(0, o.schedules - 1) }),
  );
};

const withSetting = (model: Model, channel: string, key: SettingKey, value: string): Model =>
  onOverview(model, channel, (o) => ({
    ...o,
    settings:
      value.trim() === ""
        ? Record.remove(o.settings, key)
        : Record.set(o.settings, key, value.trim()),
  }));

const withArtifact = (model: Model, channel: string, name: string, action: ArtifactAction): Model =>
  onArtifacts(model, channel, (rows) =>
    action === "delete"
      ? rows.filter((row) => row.name !== name)
      : rows.map((row) => (row.name === name ? { ...row, visibility: action } : row)),
  );

const withEdit = (model: Model, channel: string, edit: AgentEdit): Model => {
  const key = channelKey({ channel });
  switch (edit.kind) {
    case "profile":
      return modifyFields(model, {
        profile: (query) =>
          patch<ProfileData>()(query, () => ({
            about: edit.about ?? "",
            rules: edit.rules ?? [],
          })),
      });
    case "skills": {
      const name = edit.name ?? "";
      return modifyFields(model, {
        skills: (query) =>
          patchKeyed<ReadonlyArray<SkillData>>()(query, key, (rows) =>
            edit.action === "delete"
              ? rows.filter((row) => row.name !== name)
              : rows.some((row) => row.name === name)
                ? rows.map((row) =>
                    row.name === name
                      ? { ...row, description: edit.description ?? "", body: edit.body ?? "" }
                      : row,
                  )
                : [
                    ...rows,
                    {
                      name,
                      description: edit.description ?? "",
                      body: edit.body ?? "",
                      pinned: false,
                      useCount: 0,
                      usedAt: null,
                      updated: Date.now(),
                    },
                  ],
          ),
      });
    }
    case "intents":
      return modifyFields(model, {
        intents: (query) =>
          patchKeyed<ReadonlyArray<IntentData>>()(query, key, (rows) =>
            edit.action === "cancel"
              ? rows.map((row) => (row.id === edit.id ? { ...row, state: "cancelled" } : row))
              : rows.map((row) =>
                  row.id === edit.id
                    ? {
                        ...row,
                        description: edit.description ?? row.description,
                        triggers: edit.triggers ?? row.triggers,
                        expires: edit.expires ?? row.expires,
                        maxFires: edit.maxFires ?? row.maxFires,
                        cooldown:
                          edit.cooldownHours === undefined
                            ? row.cooldown
                            : edit.cooldownHours * 3_600_000,
                      }
                    : row,
                ),
          ),
      });
    case "policies":
      return modifyFields(model, {
        policies: (query) =>
          patchKeyed<ReadonlyArray<PolicyData>>()(query, key, (rows) =>
            edit.action === "remove"
              ? rows.filter((row) => row.id !== edit.id)
              : rows.map((row) =>
                  row.id === edit.id
                    ? {
                        ...row,
                        match: edit.match ?? row.match,
                        decision: edit.decision ?? row.decision,
                      }
                    : row,
                ),
          ),
      });
  }
};

const agentFields = (row: AgentRow): { readonly [key: string]: string } => ({
  slug: row.slug,
  name: row.name,
  role: row.role,
  persona: row.persona,
  model: row.model,
  tools: (row.tools ?? []).join("\n"),
});

const openAgentManager = (model: Model, slug: string): UpdateReturn => {
  if (slug === "")
    return { model: modifyFields(model, { agentForm: () => Option.some(emptyAgentForm()) }) };
  const row = Option.flatMap(AsyncData.getData(agentsQuery.read(model.agents)), (rows) =>
    Array.findFirst(rows, (agent) => agent.slug === slug),
  );
  return {
    model: modifyFields(model, {
      agentForm: () =>
        Option.map(row, (agent): AgentForm => ({ slug: agent.slug, fields: agentFields(agent) })),
      armed: () => Confirmation.Resting(),
      notice: () => Option.none(),
    }),
  };
};

/** Agents feed the rail, the jump menu and the summary table, so a change refreshes them all. */
const refreshAgents: Step = (model) =>
  Update.combine(model, [
    (stepModel) => agents.revalidate(stepModel),
    (stepModel) => channels.revalidate(stepModel),
    (stepModel) => summary.revalidate(stepModel),
    loadRoute,
  ]);

const navigate = (model: Model, route: AppRoute): UpdateReturn => ({
  model,
  commands: [NavigateInternal({ url: routeHref(route) })],
});

export const init: Runtime.RoutingApplicationInit<Model, Message> = (url: Url) => {
  const route = urlToAppRoute(url);
  const drafts = draftsOf(route);
  const model = Model.make({
    route,
    channels: channelsQuery.init(),
    agents: agentsQuery.init(),
    overview: overviewQuery.init(),
    log: logQuery.init(),
    entry: entryQuery.init(),
    memory: memoryQuery.init(),
    usage: usageQuery.init(),
    schedules: schedulesQuery.init(),
    profile: profileQuery.init(),
    skills: skillsQuery.init(),
    intents: intentsQuery.init(),
    policies: policiesQuery.init(),
    runs: runsQuery.init(),
    draftKind: drafts.draftKind,
    draftSearch: drafts.draftSearch,
    summary: summaryQuery.init(),
    audit: auditQuery.init(),
    artifacts: artifactsQuery.init(),
    artifact: artifactQuery.init(),
    recent: recentQuery.init(),
    editor: Option.none(),
    agentForm: Option.none(),
    drafts: {},
    composer: { name: "", kind: "markdown", content: "" },
    armed: Confirmation.Resting(),
    nav: NavState.Closed(),
    notice: Option.none(),
    palette: paletteMachine.initial,
    apple: typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform),
  });
  return Update.combine(model, [loadChannels, loadRoute]);
};

const foldPalette = Machine.fold({
  machine: paletteMachine,
  read: (model: Model) => Option.some(model.palette),
  write: (model, palette) => modifyFields(model, { palette: () => palette }),
  context: (model) => ({ resultCount: matches(model, currentChannel(model)).length }),
});

/**
 * A notice and an armed button are both short-lived: whichever step sets one,
 * it lapses on its own, so no stale "Done." or "Sure?" waits for the next visit.
 */
export const update = (model: Model, message: Message): UpdateReturn => {
  const result = step(model, message);
  const commands = [...(result.commands ?? [])];
  const notice = result.model.notice;
  if (Option.isSome(notice) && !Option.contains(model.notice, notice.value))
    commands.push(ExpireNotice({ text: notice.value }));
  const armed = result.model.armed;
  if (Confirmation.guards.Armed(armed) && !isArmed(model.armed, armed.key))
    commands.push(ExpireArmed({ key: armed.key }));
  return { ...result, commands };
};

const step = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),

    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => {
          const href = urlToString(url);
          // Only the admin pages are routes here; the chat is another app.
          return href.startsWith("/admin")
            ? { model, commands: [NavigateInternal({ url: href })] }
            : { model, commands: [LoadExternal({ href })] };
        },
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),

    ChangedUrl: ({ url }) =>
      Update.combine(model, [setRoute(urlToAppRoute(url)), loadChannels, loadRoute]),

    GotAgentsMessage: ({ message }) => agents.fold(model, message),
    GotChannelsMessage: ({ message }) =>
      Update.combine(model, [(stepModel) => channels.fold(stepModel, message), loadRoute]),
    GotOverviewMessage: ({ message }) => overview.fold(model, message),
    GotLogMessage: ({ message }) => log.fold(model, message),
    GotEntryMessage: ({ message }) => entry.fold(model, message),
    GotMemoryMessage: ({ message }) => memory.fold(model, message),
    GotUsageMessage: ({ message }) => usage.fold(model, message),
    GotSchedulesMessage: ({ message }) => schedules.fold(model, message),
    GotProfileMessage: ({ message }) => profile.fold(model, message),
    GotSkillsMessage: ({ message }) => skills.fold(model, message),
    GotIntentsMessage: ({ message }) => intents.fold(model, message),
    GotPoliciesMessage: ({ message }) => policies.fold(model, message),
    GotRunsMessage: ({ message }) => runs.fold(model, message),
    GotSummaryMessage: ({ message }) => summary.fold(model, message),
    GotAuditMessage: ({ message }) => audit.fold(model, message),
    GotArtifactsMessage: ({ message }) => artifacts.fold(model, message),
    GotArtifactMessage: ({ message }) => artifact.fold(model, message),

    ClickedAgentEdit: ({ kind, id }) => openEditor(model, kind, id),
    ClickedAgentNew: ({ kind }) => openEditor(model, kind, ""),
    UpdatedAgentField: ({ key, value }) => ({
      model: modifyFields(model, {
        editor: (editor) =>
          Option.map(editor, (open) => ({
            ...open,
            fields: { ...open.fields, [key]: value },
          })),
      }),
    }),
    ClickedAgentClose: () => ({
      model: modifyFields(model, {
        editor: () => Option.none(),
        armed: () => Confirmation.Resting(),
      }),
    }),
    ClickedAgentSave: () =>
      Option.match(model.editor, {
        onNone: () => ({ model }),
        onSome: (editor) => {
          const edit = editOf(editor);
          if (!edit) return { model };
          return Option.match(currentChannel(model), {
            onNone: () => ({ model }),
            onSome: (channel) => ({
              model: modifyFields(withEdit(model, channel, edit), {
                editor: () => Option.none(),
                notice: () => Option.none(),
              }),
              commands: [PostAgent({ channel, edit, editor: model.editor })],
            }),
          });
        },
      }),
    ClickedAgentRemove: ({ kind, id }) => {
      const key = `agent-remove:${kind}:${id}`;
      if (!isArmed(model.armed, key)) {
        return {
          model: modifyFields(model, {
            armed: () => Confirmation.Armed({ key }),
            notice: () => Option.none(),
          }),
        };
      }
      const edit = removalOf(kind, id);
      if (!edit) return { model };
      return Option.match(currentChannel(model), {
        onNone: () => ({ model }),
        onSome: (channel) => ({
          model: modifyFields(withEdit(model, channel, edit), {
            armed: () => Confirmation.Resting(),
            editor: () => Option.none(),
          }),
          commands: [PostAgent({ channel, edit, editor: model.editor })],
        }),
      });
    },
    FailedAgentEdit: ({ reason, editor }) =>
      loadRoute(modifyFields(model, { editor: () => editor, notice: () => Option.some(reason) })),

    ClickedAgentManage: ({ slug }) => openAgentManager(model, slug),
    UpdatedAgentManageField: ({ key, value }) => ({
      model: modifyFields(model, {
        agentForm: (form) =>
          Option.map(form, (open) => ({ ...open, fields: { ...open.fields, [key]: value } })),
      }),
    }),
    ClickedAgentManageClose: () => ({
      model: modifyFields(model, {
        agentForm: () => Option.none(),
        armed: () => Confirmation.Resting(),
      }),
    }),
    ClickedAgentManageSave: () =>
      Option.match(model.agentForm, {
        onNone: () => ({ model }),
        onSome: (form) => {
          if (!agentFormReady(form)) return { model };
          const body = managementOf(form);
          const op: AgentOp = form.slug === "" ? "create" : "update";
          const row: AgentRow = {
            doName: `agent:pending-${body.slug}`,
            slug: body.slug,
            name: body.name,
            role: body.role,
            persona: body.persona,
            tools: body.tools,
            isDefault: false,
            model: body.model,
            created: Date.now(),
            lastActive: 0,
          };
          const patched = onAgents(model, (rows) =>
            op === "create"
              ? [...rows, row]
              : rows.map((agent) =>
                  agent.slug === form.slug
                    ? {
                        ...agent,
                        ...row,
                        doName: agent.doName,
                        isDefault: agent.isDefault,
                        created: agent.created,
                        lastActive: agent.lastActive,
                      }
                    : agent,
                ),
          );
          return {
            model: modifyFields(
              op === "update"
                ? onChannels(patched, (rows) =>
                    rows.map((channel) =>
                      channel.threadId === form.slug
                        ? { ...channel, name: body.name, threadId: body.slug }
                        : channel,
                    ),
                  )
                : patched,
              { agentForm: () => Option.none(), notice: () => Option.none() },
            ),
            commands: [PostManagedAgent({ op, slug: form.slug, body, form: Option.some(form) })],
          };
        },
      }),
    ClickedAgentManageDelete: ({ slug }) => {
      const key = `agent-delete:${slug}`;
      if (!isArmed(model.armed, key)) {
        return {
          model: modifyFields(model, {
            armed: () => Confirmation.Armed({ key }),
            notice: () => Option.none(),
          }),
        };
      }
      const doName = Option.flatMap(AsyncData.getData(agentsQuery.read(model.agents)), (rows) =>
        Option.map(
          Array.findFirst(rows, (agent) => agent.slug === slug),
          (agent) => agent.doName,
        ),
      );
      const wasOpen = Option.exists(doName, (name) =>
        Option.contains(routeChannel(model.route), name),
      );
      const patched = onChannels(
        onAgents(model, (rows) => rows.filter((agent) => agent.slug !== slug)),
        (rows) => rows.filter((channel) => channel.threadId !== slug),
      );
      return {
        model: modifyFields(patched, {
          armed: () => Confirmation.Resting(),
          agentForm: () => Option.none(),
        }),
        commands: [
          PostManagedAgent({ op: "delete", slug, body: null, form: model.agentForm }),
          ...(wasOpen
            ? [NavigateInternal({ url: routeHref(AppRoute.Overview({ channel: Option.none() })) })]
            : []),
        ],
      };
    },
    FailedAgentManage: ({ reason, form }) =>
      refreshAgents(
        modifyFields(model, { agentForm: () => form, notice: () => Option.some(reason) }),
      ),

    UpdatedComposer: ({ field, value }) => ({
      model: modifyFields(model, {
        composer: (composer) =>
          field === "kind"
            ? { ...composer, kind: value === "html" ? "html" : "markdown" }
            : { ...composer, [field]: value },
      }),
    }),
    ClickedPublish: () =>
      Option.match(currentChannel(model), {
        onNone: () => ({ model }),
        onSome: (channel) => ({
          model: modifyFields(model, {
            composer: () => ({ name: "", kind: "markdown" as const, content: "" }),
            notice: () => Option.none(),
          }),
          commands: [
            PostNewArtifact({ channel, ...model.composer, name: model.composer.name.trim() }),
          ],
        }),
      }),
    SucceededPublish: ({ url }) =>
      loadRoute(modifyFields(model, { notice: () => Option.some(`Published: ${url}`) })),
    FailedPublish: ({ reason, name, kind, content }) =>
      loadRoute(
        modifyFields(model, {
          composer: () => ({ name, kind: kind === "html" ? "html" : "markdown", content }),
          notice: () => Option.some(reason),
        }),
      ),

    ClickedArtifact: ({ name, action }) => {
      const key = `artifact-${action}:${name}`;
      const channel = currentChannel(model);
      if (Option.isNone(channel)) {
        return { model };
      }
      const onlyDeletingAsksTwice = action === "delete";
      const isFirstClick = !isArmed(model.armed, key);
      if (onlyDeletingAsksTwice && isFirstClick) {
        return {
          model: modifyFields(model, {
            armed: () => Confirmation.Armed({ key }),
            notice: () => Option.none(),
          }),
        };
      }
      return {
        model: modifyFields(withArtifact(model, channel.value, name, action), {
          armed: () => Confirmation.Resting(),
        }),
        commands: [PostArtifact({ channel: channel.value, name, action })],
      };
    },
    GotRecentMessage: ({ message }) => recent.fold(model, message),

    UpdatedDraft: ({ key, value }) => ({
      model: modifyFields(model, { drafts: (drafts) => Record.set(drafts, key, value) }),
    }),
    ClickedSave: ({ key }) =>
      Option.match(currentChannel(model), {
        onNone: () => ({ model }),
        onSome: (channel) =>
          Option.match(Record.get(model.drafts, key), {
            onNone: () => ({ model }),
            onSome: (value) => ({
              model: modifyFields(withSetting(model, channel, key, value), {
                drafts: (drafts) => Record.remove(drafts, key),
                notice: () => Option.none(),
              }),
              commands: [SaveSetting({ channel, key, value })],
            }),
          }),
      }),
    ClickedResetSetting: ({ key }) =>
      Option.match(currentChannel(model), {
        onNone: () => ({ model }),
        onSome: (channel) => ({
          model: modifyFields(withSetting(model, channel, key, ""), {
            drafts: (drafts) => Record.remove(drafts, key),
            notice: () => Option.none(),
          }),
          commands: [SaveSetting({ channel, key, value: "" })],
        }),
      }),
    FailedSetting: ({ reason, key, value }) =>
      loadRoute(
        modifyFields(model, {
          drafts: (drafts) => Record.set(drafts, key, value),
          notice: () => Option.some(reason),
        }),
      ),

    SelectedChannel: ({ channel }) => navigate(model, routeOnChannel(model.route, channel)),

    UpdatedKindDraft: ({ value }) => ({
      model: modifyFields(model, { draftKind: () => value }),
    }),
    UpdatedSearchDraft: ({ value }) => ({
      model: modifyFields(model, { draftSearch: () => value }),
    }),
    SubmittedFilter: () =>
      navigate(
        model,
        AppRoute.Log({
          channel: routeChannel(model.route),
          kind: Option.liftPredicate(model.draftKind, (text) => text !== ""),
          q: Option.liftPredicate(model.draftSearch.trim(), (text) => text !== ""),
          before: Option.none(),
        }),
      ),

    ClickedRetry: () => loadRoute(model),

    ClickedAction: ({ action, id }) => {
      const key = `${action}:${id}`;
      const channel = currentChannel(model);
      if (Option.isNone(channel) || !isArmed(model.armed, key)) {
        return {
          model: modifyFields(model, {
            armed: () => Confirmation.Armed({ key }),
            notice: () => Option.none(),
          }),
        };
      }
      return {
        model: modifyFields(withAction(model, channel.value, action, id), {
          armed: () => Confirmation.Resting(),
        }),
        commands: [PostAction({ channel: channel.value, action, id })],
      };
    },
    SucceededAction: () => refreshAgents(model),
    FailedAction: ({ reason }) =>
      loadRoute(modifyFields(model, { notice: () => Option.some(reason) })),

    ToggledNav: () => ({
      model: modifyFields(model, {
        nav: (nav) =>
          NavState.match(nav, { Closed: () => NavState.Open(), Open: () => NavState.Closed() }),
      }),
    }),
    SwipedRight: () => ({ model: modifyFields(model, { nav: () => NavState.Open() }) }),
    SwipedLeft: () => ({ model: modifyFields(model, { nav: () => NavState.Closed() }) }),
    ClosedNav: () => ({ model: modifyFields(model, { nav: () => NavState.Closed() }) }),

    PressedPalette: () => {
      const next = foldPalette(model, message);
      return PaletteState.guards.Open(next.model.palette)
        ? {
            ...next,
            commands: [...(next.commands ?? []), FocusAfterPaint({ selector: "#palette-input" })],
          }
        : next;
    },
    ClosedPalette: () => foldPalette(model, message),
    TypedPaletteQuery: () => foldPalette(model, message),
    MovedPaletteSelection: () => foldPalette(model, message),
    ChosePalette: ({ index }) => {
      const chosen = matches(model, currentChannel(model))[index];
      return chosen === undefined
        ? { model }
        : goTo(foldPalette(model, message).model, chosen.href);
    },
    PressedGo: ({ id }) => {
      const section = sections(model).find((entry) => entry.id === id);
      return section === undefined
        ? { model }
        : goTo(foldPalette(model, message).model, section.href);
    },
    PressedSearch: () => ({ model, commands: [FocusAfterPaint({ selector: "#log-search" })] }),
    CompletedFocus: () => ({ model }),
    ExpiredNotice: ({ text }) => ({
      model: Option.contains(model.notice, text)
        ? modifyFields(model, { notice: () => Option.none() })
        : model,
    }),
    ExpiredArmed: ({ key }) => ({
      model: isArmed(model.armed, key)
        ? modifyFields(model, { armed: () => Confirmation.Resting() })
        : model,
    }),
    PressedEscape: () => ({
      model: modifyFields(model, { armed: () => Confirmation.Resting() }),
    }),

    TickedOverviewRefresh: () =>
      Option.match(currentChannel(model), {
        onNone: () => ({ model }),
        onSome: (channel) =>
          Update.combine(model, [
            (stepModel) => overview.revalidate(stepModel, { channel }),
            (stepModel) => recent.revalidate(stepModel, { channel }),
            (stepModel) => summary.revalidate(stepModel),
          ]),
      }),
  });

export const subscriptions = Subscription.make<Model, Message>()((entryOf) => ({
  swipe: Subscription.persistentEntry(
    swipeDrawer<Message>({
      maxWidth: 899,
      width: (viewport) => Math.min(320, viewport * 0.88),
      open: () => Message.SwipedRight(),
      close: () => Message.SwipedLeft(),
    }),
  ),
  keys: entryOf(
    { isPaletteOpen: Schema.Boolean, isOnLog: Schema.Boolean, isArmed: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        isPaletteOpen: PaletteState.guards.Open(model.palette),
        isOnLog: Predicate.isTagged(model.route, "Log"),
        isArmed: Confirmation.guards.Armed(model.armed),
      }),
      dependenciesToStream: ({ isPaletteOpen, isOnLog, isArmed }) =>
        Dom.streamFromKeyBindings<Message>({
          bindings: [
            { keys: "Mod+K", whileTyping: "Allow", mapEvent: () => Message.PressedPalette() },
            {
              keys: "Escape",
              isEnabled: isPaletteOpen,
              whileTyping: "Allow",
              mapEvent: () => Message.ClosedPalette(),
            },
            {
              keys: "Escape",
              isEnabled: isArmed && !isPaletteOpen,
              whileTyping: "Allow",
              mapEvent: () => Message.PressedEscape(),
            },
            { keys: "/", isEnabled: isOnLog, mapEvent: () => Message.PressedSearch() },
            ...Object.entries(GO_KEYS).map(([id, key]) => ({
              keys: ["G", key.toUpperCase()] as const,
              isEnabled: !isPaletteOpen,
              mapEvent: () => Message.PressedGo({ id }),
            })),
          ],
        }),
    },
  ),
  refreshOverview: entryOf(
    { isRefreshActive: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        isRefreshActive:
          Predicate.isTagged(model.route, "Overview") &&
          Option.exists(currentChannel(model), (channel) =>
            AsyncData.hasData(overviewQuery.read(model.overview, { channel })),
          ),
      }),
      dependenciesToStream: ({ isRefreshActive }) =>
        Stream.when(
          Stream.tick(OVERVIEW_REFRESH).pipe(
            Stream.drop(1),
            Stream.map(() => Message.TickedOverviewRefresh()),
          ),
          Effect.sync(() => isRefreshActive),
        ),
    },
  ),
}));
