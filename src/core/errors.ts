import { Schema } from "effect";

// Agent lifecycle
export class AgentLookupError extends Schema.TaggedErrorClass<AgentLookupError>()(
  "AgentLookupError",
  { cause: Schema.Defect },
) {}

// Model operations
export class ModelQueryError extends Schema.TaggedErrorClass<ModelQueryError>()(
  "ModelQueryError",
  { cause: Schema.Defect },
) {}

export class ModelSetError extends Schema.TaggedErrorClass<ModelSetError>()(
  "ModelSetError",
  { cause: Schema.Defect },
) {}

// Chat / channel operations (posting, subscribing, typing, streams)
export class ChatActionError extends Schema.TaggedErrorClass<ChatActionError>()(
  "ChatActionError",
  { cause: Schema.Defect },
) {}

// Session management (clear, refresh, compaction)
export class SessionError extends Schema.TaggedErrorClass<SessionError>()(
  "SessionError",
  { cause: Schema.Defect },
) {}

// Durable Object storage
export class StorageError extends Schema.TaggedErrorClass<StorageError>()(
  "StorageError",
  { cause: Schema.Defect },
) {}

// Request handling
export class WebhookError extends Schema.TaggedErrorClass<WebhookError>()(
  "WebhookError",
  { cause: Schema.Defect },
) {}

export class ScreenshotError extends Schema.TaggedErrorClass<ScreenshotError>()(
  "ScreenshotError",
  { cause: Schema.Defect },
) {}

// Agent RPC
export class AgentRpcError extends Schema.TaggedErrorClass<AgentRpcError>()("AgentRpcError", {
  cause: Schema.Defect,
}) {}
