import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";
import { Message as UiMessage } from "@mizook/ui";

import { Bootstrap, SendReplySchema, ThreadState, ThreadSummary } from "./api.ts";

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigation: {},
  CompletedScroll: {},

  LoadedBootstrap: { data: Bootstrap },
  FailedBootstrap: { reason: Schema.String },
  RestoredBootstrap: { data: Schema.Option(Bootstrap) },
  LoadedThread: { threadId: Schema.String, state: ThreadState },
  FailedThread: { threadId: Schema.String, reason: Schema.String },
  RestoredThread: { threadId: Schema.String, state: Schema.Option(ThreadState) },
  PolledThread: { threadId: Schema.String, state: ThreadState },
  FailedPoll: { threadId: Schema.String, reason: Schema.String },
  CompletedSave: {},
  WentOffline: {},
  WentOnline: {},

  CreatedThread: {
    thread: ThreadSummary,
    text: Schema.String,
    requestId: Schema.String,
  },
  FailedCreate: { reason: Schema.String },
  SentMessage: { threadId: Schema.String, text: Schema.String, result: SendReplySchema },
  FailedSend: { reason: Schema.String },
  Stopped: { ok: Schema.Boolean },
  FailedStop: { reason: Schema.String },
  Approved: { ok: Schema.Boolean },
  FailedApprove: { reason: Schema.String },
  Renamed: { thread: ThreadSummary },
  FailedRename: { reason: Schema.String },
  Archived: { id: Schema.String },
  FailedArchive: { reason: Schema.String },

  ClickedThread: { id: Schema.String },
  ClickedNewChat: {},
  ClickedSend: {},
  ClickedStop: {},
  ClickedRetry: {},
  ClickedRename: {},
  ClickedCloseRename: {},
  ClickedSaveRename: {},
  ClickedArchive: {},
  ClickedApprove: {
    approvalId: Schema.Finite,
    action: Schema.Literals(["approve", "always", "deny"]),
  },
  ClickedPrompt: { text: Schema.String },
  ClickedChoice: { text: Schema.String },
  ClickedDismissNotice: {},
  GotUiMessage: { message: UiMessage },
});

export type Message = typeof Message.Type;
