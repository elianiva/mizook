import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { File as FileSchema } from "foldkit/file";
import { Attachment, Bootstrap, ChatState, ThreadState } from "@mizook/chat-sync";
import { Confirmation } from "@mizook/ui/confirmation";

import { kit } from "./kit.ts";
import { TurnState } from "./turn-machine.ts";
import { AppRoute } from "./route.ts";

const BootstrapData = AsyncData.Schema(Bootstrap, Schema.String);
const ThreadData = AsyncData.Schema(ThreadState, Schema.String);

/**
 * One image in the composer. `file` is there until the upload lands; an image
 * restored after a failed send has only the uploaded copy to show.
 */
export const PendingImage = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  preview: Schema.String,
  file: Schema.Option(FileSchema),
  uploaded: Schema.Option(Attachment),
});
export type PendingImage = typeof PendingImage.Type;

export const Model = Schema.Struct({
  anchorId: Schema.String,
  route: AppRoute,
  bootstrap: BootstrapData.schema,
  thread: ThreadData.schema,
  chat: Schema.Option(ChatState),
  ui: kit.Model,
  turn: TurnState,
  attachments: Schema.Array(PendingImage),
  dragging: Schema.Boolean,
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
