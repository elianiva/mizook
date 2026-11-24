import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";
import { Message as UiMessage } from "@mizook/ui";
import { ThreadSummary } from "@mizook/chat-sync";

import { SyncView } from "./sync.ts";

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigation: {},
  CompletedScroll: {},
  CompletedFocus: {},
  ScrolledThread: { threadId: Schema.String, atBottom: Schema.Boolean },

  Synced: { view: SyncView },
  RefreshTick: {},
  Refreshed: {},
  FailedRefresh: { reason: Schema.String },
  Recovered: {},
  FailedRecover: { reason: Schema.String },

  SentMessage: { threadId: Schema.String, text: Schema.String },
  FailedSend: {
    reason: Schema.String,
    text: Schema.optionalKey(Schema.String),
    threadId: Schema.optionalKey(Schema.String),
  },
  Stopped: { ok: Schema.Boolean },
  FailedStop: { reason: Schema.String },
  Approved: { ok: Schema.Boolean },
  FailedApprove: { reason: Schema.String },
  Renamed: { thread: ThreadSummary },
  FailedRename: { reason: Schema.String },
  Archived: { id: Schema.String },
  FailedArchive: { reason: Schema.String },

  WentOffline: {},
  WentOnline: {},

  ClickedThread: { id: Schema.String },
  SwipedRight: {},
  SwipedLeft: {},
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
  ClickedChoice: { text: Schema.String },
  ClickedDismissNotice: {},
  ClickedLatest: {},
  ClickedCopy: { id: Schema.Finite, text: Schema.String },
  Copied: { id: Schema.Finite },
  ExpiredCopied: { id: Schema.Finite, count: Schema.Finite },
  ExpiredToast: { text: Schema.String },
  ExpiredArmed: { key: Schema.String },
  PressedSlash: {},
  GotUiMessage: { message: UiMessage },
});

export type Message = typeof Message.Type;
