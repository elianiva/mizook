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
import { Confirmation } from "./confirmation.ts";
import { NavState } from "./nav.ts";
import { PaletteState } from "./palette-machine.ts";
import { AppRoute } from "./route.ts";

const OpenAgentForm = Schema.Option(
  Schema.Struct({
    kind: AgentKind,
    id: Schema.String,
    fields: Schema.Record(Schema.String, Schema.String),
  }),
);

const UnsavedSettingInputs = Schema.Record(Schema.String, Schema.String);

const ArtifactBeingWritten = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["markdown", "html"]),
  content: Schema.String,
});

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
  summary: summaryQuery.Model,
  audit: auditQuery.Model,
  artifacts: artifactsQuery.Model,
  artifact: artifactQuery.Model,
  recent: recentQuery.Model,
  editor: OpenAgentForm,
  drafts: UnsavedSettingInputs,
  composer: ArtifactBeingWritten,
  armed: Confirmation,
  nav: NavState,
  notice: Schema.Option(Schema.String),
  palette: PaletteState,
  /** Whether shortcut hints read ⌘ or Ctrl. Set once at start. */
  apple: Schema.Boolean,
});

export type Model = typeof Model.Type;
