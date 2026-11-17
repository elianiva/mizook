import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";

import {
  channelsQuery,
  entryQuery,
  logQuery,
  memoryQuery,
  overviewQuery,
  schedulesQuery,
  usageQuery,
} from "./api.ts";

export const Message = defineMessageUnion({
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  GotChannelsMessage: { message: channelsQuery.Message },
  GotOverviewMessage: { message: overviewQuery.Message },
  GotLogMessage: { message: logQuery.Message },
  GotEntryMessage: { message: entryQuery.Message },
  GotMemoryMessage: { message: memoryQuery.Message },
  GotUsageMessage: { message: usageQuery.Message },
  GotSchedulesMessage: { message: schedulesQuery.Message },
  SelectedChannel: { channel: Schema.String },
  UpdatedKindDraft: { value: Schema.String },
  UpdatedSearchDraft: { value: Schema.String },
  SubmittedFilter: {},
  ClickedRetry: {},
  TickedOverviewRefresh: {},
});

export type Message = typeof Message.Type;
