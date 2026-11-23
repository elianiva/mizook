import { Schema } from "effect";
import { AsyncData } from "foldkit";

import { ChatState } from "@mizook/chat-sync";
import { Bootstrap, ThreadState } from "./api.ts";
import { kit } from "./kit.ts";
import { TurnState } from "./turn-machine.ts";
import { AppRoute } from "./route.ts";

const BootstrapData = AsyncData.Schema(Bootstrap, Schema.String);
const ThreadData = AsyncData.Schema(ThreadState, Schema.String);

export const Model = Schema.Struct({
  anchorId: Schema.String,
  route: AppRoute,
  bootstrap: BootstrapData.schema,
  thread: ThreadData.schema,
  chat: Schema.Option(ChatState),
  ui: kit.Model,
  turn: TurnState,
  notice: Schema.Option(Schema.String),
  offline: Schema.Boolean,
  saved: Schema.Boolean,
  armedArchive: Schema.Option(Schema.String),
  renameThreadId: Schema.Option(Schema.String),
  copied: Schema.Option(Schema.Finite),
});

export type Model = typeof Model.Type;
