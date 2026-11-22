import { Option, Schema, pipe } from "effect";
import {
  defineRouteUnion,
  literal,
  mapTo,
  oneOf,
  parseUrlWithFallback,
  root,
  slash,
  string,
} from "foldkit/route";

export const AppRoute = defineRouteUnion({
  Home: {},
  Thread: { threadId: Schema.String },
  NotFound: { path: Schema.String },
});
export type AppRoute = typeof AppRoute.Type;

const homeRouter = pipe(literal("c"), mapTo(AppRoute.Home));
const rootRouter = pipe(root, mapTo(AppRoute.Home));
const threadRouter = pipe(literal("c"), slash(string("threadId")), mapTo(AppRoute.Thread));

export const urlToAppRoute = parseUrlWithFallback(
  oneOf(threadRouter, homeRouter, rootRouter),
  AppRoute.NotFound,
);

export const routeHref = (route: AppRoute): string =>
  AppRoute.match<string>(route, {
    Home: () => homeRouter(),
    Thread: ({ threadId }) => threadRouter({ threadId }),
    NotFound: () => homeRouter(),
  });

export const routeThread = (route: AppRoute): Option.Option<string> =>
  AppRoute.match<Option.Option<string>>(route, {
    Home: () => Option.none(),
    Thread: ({ threadId }) => Option.some(threadId),
    NotFound: () => Option.none(),
  });
