import { Schema } from "effect";

export class ModelRequestError extends Schema.TaggedErrorClass<ModelRequestError>()(
  "ModelRequestError",
  {
    cause: Schema.Defect,
  },
) {}

export class AgentLookupError extends Schema.TaggedErrorClass<AgentLookupError>()(
  "AgentLookupError",
  {
    cause: Schema.Defect,
  },
) {}

export class AgentRpcError extends Schema.TaggedErrorClass<AgentRpcError>()("AgentRpcError", {
  cause: Schema.Defect,
}) {}
