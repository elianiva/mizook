import { Schema } from "effect";

import {
  auditQuery,
  channelsQuery,
  entryQuery,
  logQuery,
  memoryQuery,
  overviewQuery,
  recentQuery,
  summaryQuery,
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
  /** The action waiting for a second click, as `kind:id`. */
  summary: summaryQuery.Model,
  audit: auditQuery.Model,
  recent: recentQuery.Model,
  /** Setting inputs the person has changed and not saved yet. */
  drafts: Schema.Record(Schema.String, Schema.String),
  armed: Schema.Option(Schema.String),
  notice: Schema.Option(Schema.String),
});

export type Model = typeof Model.Type;
