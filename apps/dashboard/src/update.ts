import { Array, Duration, Effect, Option, Schema, Stream, pipe } from "effect";
import { AsyncData, Command, Runtime, Subscription, Update } from "foldkit";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import { type Url, toString as urlToString } from "foldkit/url";

import {
  channelsQuery,
  entryQuery,
  logQuery,
  memoryQuery,
  overviewQuery,
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
const schedules = schedulesQuery.lift<Model, Message>({
  parentField: "schedules",
  toParentMessage: (message) => Message.GotSchedulesMessage({ message }),
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
    NotFound: () => ({ draftKind: "", draftSearch: "" }),
  });

const setRoute =
  (route: AppRoute): Step =>
  (model) => {
    const drafts = draftsOf(route);
    return {
      model: modifyFields(model, {
        route: () => route,
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
        Overview: () => overview.revalidateOrLoad(model, { channel }),
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
    draftKind: drafts.draftKind,
    draftSearch: drafts.draftSearch,
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

    TickedOverviewRefresh: () =>
      Option.match(currentChannel(model), {
        onNone: () => ({ model }),
        onSome: (channel) => overview.revalidate(model, { channel }),
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
