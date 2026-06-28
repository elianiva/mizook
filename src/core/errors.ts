import { Schema } from "effect";

export class ModelTimeoutError extends Schema.TaggedErrorClass<ModelTimeoutError>()(
  "ModelTimeoutError",
  { timeoutMs: Schema.Number },
) {}

export class ModelRequestError extends Schema.TaggedErrorClass<ModelRequestError>()(
  "ModelRequestError",
  { cause: Schema.Unknown },
) {}

export class AgentLookupError extends Schema.TaggedErrorClass<AgentLookupError>()(
  "AgentLookupError",
  { cause: Schema.Unknown },
) {}

export class AgentRpcError extends Schema.TaggedErrorClass<AgentRpcError>()(
  "AgentRpcError",
  { cause: Schema.Unknown },
) {}
