import { Schema } from "effect";
import { AsyncData } from "foldkit";

import { Bootstrap, ThreadState } from "./api.ts";
import { kit } from "./kit.ts";
import { AppRoute } from "./route.ts";

const BootstrapData = AsyncData.Schema(Bootstrap, Schema.String);
const ThreadData = AsyncData.Schema(ThreadState, Schema.String);

export const Model = Schema.Struct({
  anchorId: Schema.String,
  route: AppRoute,
  bootstrap: BootstrapData.schema,
  thread: ThreadData.schema,
  ui: kit.Model,
  sending: Schema.Boolean,
  stopping: Schema.Boolean,
  notice: Schema.Option(Schema.String),
  offline: Schema.Boolean,
  bootstrapSaved: Schema.Boolean,
  threadSaved: Schema.Boolean,
  armedArchive: Schema.Option(Schema.String),
  renameThreadId: Schema.Option(Schema.String),
  pollAfter: Schema.Finite,
});
export type Model = typeof Model.Type;
