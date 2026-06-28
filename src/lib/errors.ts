import { Data } from "effect";

export class ModelTimeoutError extends Data.TaggedError("ModelTimeoutError")<{
  readonly timeoutMs: number;
}> {}

export class ModelRequestError extends Data.TaggedError("ModelRequestError")<{
  readonly cause: unknown;
}> {}

export class AgentLookupError extends Data.TaggedError("AgentLookupError")<{
  readonly cause: unknown;
}> {}

export class AgentRpcError extends Data.TaggedError("AgentRpcError")<{
  readonly cause: unknown;
}> {}
