import { Array, Duration, Effect, Option, Record, Schema, Stream, pipe } from "effect";
import { AsyncData, Command, Runtime, Subscription, Update } from "foldkit";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import { type Url, toString as urlToString } from "foldkit/url";

import {
  ActionKind,
  ArtifactAction,
  artifactQuery,
  artifactsQuery,
  postArtifact,
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
import { Message } from "./message.ts";
import { Model } from "./model.ts";
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

// COMMAND

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
  messages: [Message.SucceededPublish, Message.FailedAction],
  execute: ({ channel, name, kind, content }) =>
    postNewArtifact(channel, { name, kind, content }).pipe(
      Effect.map((url) => Message.SucceededPublish({ url })),
      Effect.catch((reason) => Effect.succeed(Message.FailedAction({ reason }))),
    ),
});

const SaveSetting = Command.define("SaveSetting", {
  args: { channel: Schema.String, key: SettingKey, value: Schema.String },
  messages: [Message.SucceededSetting, Message.FailedAction],
  execute: ({ channel, key, value }) =>
    postSetting(channel, key, value).pipe(
      Effect.map((said) => Message.SucceededSetting({ key, said })),
      Effect.catch((reason) => Effect.succeed(Message.FailedAction({ reason }))),
    ),
});

// QUERIES

const channels = channelsQuery.lift<Model, Message>({
  parentField: "channels",
  toParentMessage: (message) => Message.GotChannelsMessage({ message }),
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

/** The channel in the URL, or the most recently active one when the URL names none. */
export const currentChannel = (model: Model): Option.Option<string> =>
  Option.orElse(routeChannel(model.route), () =>
    pipe(
      AsyncData.getData(channelsQuery.read(model.channels)),
      Option.flatMap(Array.head),
      Option.map(({ doName }) => doName),
    ),
  );

// UPDATE

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
        armed: () => Option.none(),
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
        Agent: () =>
          Update.combine(model, [
            (stepModel) => profile.revalidateOrLoad(stepModel),
            (stepModel) => skills.revalidateOrLoad(stepModel, { channel }),
            (stepModel) => intents.revalidateOrLoad(stepModel, { channel }),
            (stepModel) => policies.revalidateOrLoad(stepModel, { channel }),
          ]),
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
    drafts: {},
    composer: { name: "", kind: "markdown", content: "" },
    armed: Option.none(),
    notice: Option.none(),
  });
  return Update.combine(model, [loadChannels, loadRoute]);
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),

    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [NavigateInternal({ url: urlToString(url) })],
        }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),

    ChangedUrl: ({ url }) =>
      Update.combine(model, [setRoute(urlToAppRoute(url)), loadChannels, loadRoute]),

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
          model: modifyFields(model, { notice: () => Option.none() }),
          commands: [
            PostNewArtifact({ channel, ...model.composer, name: model.composer.name.trim() }),
          ],
        }),
      }),
    SucceededPublish: ({ url }) =>
      loadRoute(
        modifyFields(model, {
          composer: () => ({ name: "", kind: "markdown" as const, content: "" }),
          notice: () => Option.some(`Published: ${url}`),
        }),
      ),

    ClickedArtifact: ({ name, action }) => {
      const key = `artifact-${action}:${name}`;
      const channel = currentChannel(model);
      if (Option.isNone(channel)) {
        return { model };
      }
      // Deleting asks twice; opening or closing the link does not.
      if (action === "delete" && !Option.contains(model.armed, key)) {
        return {
          model: modifyFields(model, {
            armed: () => Option.some(key),
            notice: () => Option.none(),
          }),
        };
      }
      return {
        model: modifyFields(model, { armed: () => Option.none() }),
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
              model: modifyFields(model, { notice: () => Option.none() }),
              commands: [SaveSetting({ channel, key, value })],
            }),
          }),
      }),
    ClickedResetSetting: ({ key }) =>
      Option.match(currentChannel(model), {
        onNone: () => ({ model }),
        onSome: (channel) => ({
          model: modifyFields(model, { notice: () => Option.none() }),
          commands: [SaveSetting({ channel, key, value: "" })],
        }),
      }),
    SucceededSetting: ({ key, said }) =>
      loadRoute(
        modifyFields(model, {
          drafts: (drafts) => Record.remove(drafts, key),
          notice: () => Option.some(said),
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
      if (Option.isNone(channel) || !Option.contains(model.armed, key)) {
        return {
          model: modifyFields(model, {
            armed: () => Option.some(key),
            notice: () => Option.none(),
          }),
        };
      }
      return {
        model: modifyFields(model, { armed: () => Option.none() }),
        commands: [PostAction({ channel: channel.value, action, id })],
      };
    },
    SucceededAction: () => loadRoute(modifyFields(model, { notice: () => Option.some("Done.") })),
    FailedAction: ({ reason }) =>
      loadRoute(modifyFields(model, { notice: () => Option.some(reason) })),

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

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message>()((entryOf) => ({
  refreshOverview: entryOf(
    { isRefreshActive: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        isRefreshActive:
          model.route._tag === "Overview" &&
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
