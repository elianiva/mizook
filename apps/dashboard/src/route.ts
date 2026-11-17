import { Option, Schema, pipe } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion, int, literal, slash } from "foldkit/route";

const MaybeString = Schema.Option(Schema.String);

export const AppRoute = defineRouteUnion({
  Overview: { channel: MaybeString },
  Log: { channel: MaybeString, kind: MaybeString, q: MaybeString, before: MaybeString },
  Entry: { entryId: Schema.Finite, channel: MaybeString },
  Memory: { channel: MaybeString },
  Usage: { channel: MaybeString, days: MaybeString },
  Schedules: { channel: MaybeString },
  Settings: { channel: MaybeString },
  Audit: { channel: MaybeString },
  Artifacts: { channel: MaybeString, name: MaybeString },
  NotFound: { path: Schema.String },
});

export type AppRoute = typeof AppRoute.Type;

const optional = Schema.OptionFromOptional(Schema.String);

const admin = literal("admin");

export const overviewRouter = pipe(
  admin,
  Route.query(Schema.Struct({ channel: optional })),
  Route.mapTo(AppRoute.Overview),
);

export const logRouter = pipe(
  admin,
  slash(literal("log")),
  Route.query(Schema.Struct({ channel: optional, kind: optional, q: optional, before: optional })),
  Route.mapTo(AppRoute.Log),
);

export const entryRouter = pipe(
  admin,
  slash(literal("log")),
  slash(int("entryId")),
  Route.query(Schema.Struct({ channel: optional })),
  Route.mapTo(AppRoute.Entry),
);

export const memoryRouter = pipe(
  admin,
  slash(literal("memory")),
  Route.query(Schema.Struct({ channel: optional })),
  Route.mapTo(AppRoute.Memory),
);

export const usageRouter = pipe(
  admin,
  slash(literal("usage")),
  Route.query(Schema.Struct({ channel: optional, days: optional })),
  Route.mapTo(AppRoute.Usage),
);

export const schedulesRouter = pipe(
  admin,
  slash(literal("schedules")),
  Route.query(Schema.Struct({ channel: optional })),
  Route.mapTo(AppRoute.Schedules),
);

export const settingsRouter = pipe(
  admin,
  slash(literal("settings")),
  Route.query(Schema.Struct({ channel: optional })),
  Route.mapTo(AppRoute.Settings),
);

export const auditRouter = pipe(
  admin,
  slash(literal("audit")),
  Route.query(Schema.Struct({ channel: optional })),
  Route.mapTo(AppRoute.Audit),
);

export const artifactsRouter = pipe(
  admin,
  slash(literal("artifacts")),
  Route.query(Schema.Struct({ channel: optional, name: optional })),
  Route.mapTo(AppRoute.Artifacts),
);

const routeParser = Route.oneOf(
  entryRouter,
  logRouter,
  memoryRouter,
  usageRouter,
  schedulesRouter,
  settingsRouter,
  auditRouter,
  artifactsRouter,
  overviewRouter,
);

export const urlToAppRoute = Route.parseUrlWithFallback(routeParser, AppRoute.NotFound);

export const routeChannel = (route: AppRoute): Option.Option<string> =>
  AppRoute.match<Option.Option<string>>(route, {
    Overview: ({ channel }) => channel,
    Log: ({ channel }) => channel,
    Entry: ({ channel }) => channel,
    Memory: ({ channel }) => channel,
    Usage: ({ channel }) => channel,
    Schedules: ({ channel }) => channel,
    Settings: ({ channel }) => channel,
    Audit: ({ channel }) => channel,
    Artifacts: ({ channel }) => channel,
    NotFound: () => Option.none(),
  });

export const routeHref = (route: AppRoute): string =>
  AppRoute.match<string>(route, {
    Overview: overviewRouter,
    Log: logRouter,
    Entry: entryRouter,
    Memory: memoryRouter,
    Usage: usageRouter,
    Schedules: schedulesRouter,
    Settings: settingsRouter,
    Audit: auditRouter,
    Artifacts: artifactsRouter,
    NotFound: () => overviewRouter({ channel: Option.none() }),
  });

/** The same page on another channel. Anything channel-specific, such as a log page, starts over. */
export const routeOnChannel = (route: AppRoute, channel: string): AppRoute => {
  const selected = Option.some(channel);
  return AppRoute.match<AppRoute>(route, {
    Overview: () => AppRoute.Overview({ channel: selected }),
    Log: ({ kind, q }) => AppRoute.Log({ channel: selected, kind, q, before: Option.none() }),
    Entry: () =>
      AppRoute.Log({
        channel: selected,
        kind: Option.none(),
        q: Option.none(),
        before: Option.none(),
      }),
    Memory: () => AppRoute.Memory({ channel: selected }),
    Usage: ({ days }) => AppRoute.Usage({ channel: selected, days }),
    Schedules: () => AppRoute.Schedules({ channel: selected }),
    Settings: () => AppRoute.Settings({ channel: selected }),
    Audit: () => AppRoute.Audit({ channel: selected }),
    Artifacts: () => AppRoute.Artifacts({ channel: selected, name: Option.none() }),
    NotFound: () => AppRoute.Overview({ channel: selected }),
  });
};

export const USAGE_DAYS = [7, 30, 90] as const;

/** The range a usage route asks for: one of the offered ones, 30 days by default. */
export const daysOf = (days: Option.Option<string>): number => {
  const asked = Number(Option.getOrElse(days, () => ""));
  return USAGE_DAYS.find((allowed) => allowed === asked) ?? 30;
};

export const textOf = (value: Option.Option<string>): string => Option.getOrElse(value, () => "");
