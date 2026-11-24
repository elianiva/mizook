import { Schema } from "effect";
import { AsyncData } from "foldkit";

import { ChatState } from "@mizook/chat-sync";
import { Bootstrap, ThreadState } from "./api.ts";
import { kit } from "./kit.ts";
import { Confirmation } from "./confirmation.ts";
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
  /** The reader is at the bottom of the open thread, following its newest message. */
  atBottom: Schema.Boolean,
  /** A touch screen: Enter adds a line, and only the Send button sends. */
  touch: Schema.Boolean,
  saved: Schema.Boolean,
  armedArchive: Confirmation,
  renameThreadId: Schema.Option(Schema.String),
  // `count` tells one press of Copy from the next, so a second press restarts the reset timer.
  copied: Schema.Option(Schema.Struct({ id: Schema.Finite, count: Schema.Finite })),
  toast: Schema.Option(Schema.String),
});

export type Model = typeof Model.Type;
