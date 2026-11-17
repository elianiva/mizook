import { Schema } from "effect";

import {
  channelsQuery,
  entryQuery,
  logQuery,
  memoryQuery,
  overviewQuery,
  schedulesQuery,
  usageQuery,
} from "./api.ts";
import { AppRoute } from "./route.ts";

export const Model = Schema.Struct({
  route: AppRoute,
  channels: channelsQuery.Model,
  overview: overviewQuery.Model,
  log: logQuery.Model,
  entry: entryQuery.Model,
  memory: memoryQuery.Model,
  usage: usageQuery.Model,
  schedules: schedulesQuery.Model,
  draftKind: Schema.String,
  draftSearch: Schema.String,
});

export type Model = typeof Model.Type;
