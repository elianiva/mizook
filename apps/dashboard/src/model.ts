import { Schema } from "effect";

import {
  AgentKind,
  artifactQuery,
  artifactsQuery,
  auditQuery,
  channelsQuery,
  entryQuery,
  intentsQuery,
  logQuery,
  memoryQuery,
  overviewQuery,
  policiesQuery,
  profileQuery,
  recentQuery,
  runsQuery,
  skillsQuery,
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
  profile: profileQuery.Model,
  skills: skillsQuery.Model,
  intents: intentsQuery.Model,
  policies: policiesQuery.Model,
  runs: runsQuery.Model,
  draftKind: Schema.String,
  draftSearch: Schema.String,
  /** The action waiting for a second click, as `kind:id`. */
  summary: summaryQuery.Model,
  audit: auditQuery.Model,
  artifacts: artifactsQuery.Model,
  artifact: artifactQuery.Model,
  recent: recentQuery.Model,
  /** The Agent form that is open, if any. `id` is a skill name, intent id or policy id. */
  editor: Schema.Option(
    Schema.Struct({
      kind: AgentKind,
      id: Schema.String,
      fields: Schema.Record(Schema.String, Schema.String),
    }),
  ),
  /** Setting inputs the person has changed and not saved yet. */
  drafts: Schema.Record(Schema.String, Schema.String),
  /** The artifact being written on the Artifacts page. */
  composer: Schema.Struct({
    name: Schema.String,
    kind: Schema.Literals(["markdown", "html"]),
    content: Schema.String,
  }),
  armed: Schema.Option(Schema.String),
  notice: Schema.Option(Schema.String),
});

export type Model = typeof Model.Type;
