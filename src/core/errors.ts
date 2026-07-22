import { Data, Schema } from "effect";

// Durable Object storage
export class StorageError extends Schema.TaggedErrorClass<StorageError>()("StorageError", {
  cause: Schema.Defect,
}) {}

// Request handling
export class ScreenshotError extends Schema.TaggedErrorClass<ScreenshotError>()("ScreenshotError", {
  cause: Schema.Defect,
}) {}

// Structured tool execution failure with LLM-actionable remediation
export class ToolExecutionError extends Data.TaggedError("ToolExecutionError")<{
  readonly tool: string;
  readonly kind: "rate_limit" | "auth_required" | "timeout" | "validation" | "unknown";
  readonly message: string;
  readonly nextStep: string;
  readonly suggestedAction?: {
    readonly type: string;
    readonly params?: Record<string, string>;
  };
}> {}

// Budget timeout exceeded during a non-critical operation
export class BudgetExceededError extends Data.TaggedError("BudgetExceededError")<{
  readonly budgetMs: number;
  readonly operation: string;
}> {}
