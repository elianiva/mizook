import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";
import { Message as UiMessage } from "@mizook/ui";

import { ThreadSummary } from "./api.ts";
import { SyncView } from "./sync.ts";

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigation: {},
  CompletedScroll: {},

  Synced: { view: SyncView },
  RefreshTick: {},
  Refreshed: {},
  FailedRefresh: { reason: Schema.String },
  Recovered: {},
  FailedRecover: { reason: Schema.String },

  SentMessage: { threadId: Schema.String, text: Schema.String },
  FailedSend: { reason: Schema.String },
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
  ClickedLatest: {},
  ClickedCopy: { id: Schema.Finite, text: Schema.String },
  Copied: { id: Schema.Finite },
  GotUiMessage: { message: UiMessage },
});

export type Message = typeof Message.Type;
