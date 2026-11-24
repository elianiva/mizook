import { Data, Effect } from "effect";

export class ModelNotFound extends Data.TaggedError("ModelNotFound")<{
  readonly provider: string;
  readonly model: string;
}> {
  override get message() {
    return `no model ${this.provider}/${this.model}`;
  }
}

export class DurableError extends Data.TaggedError("DurableError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `${this.operation} failed: ${String(this.cause)}`;
  }
}

export class StateError extends Data.TaggedError("StateError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `state ${this.operation} failed: ${String(this.cause)}`;
  }
}

export class TelegramError extends Data.TaggedError("TelegramError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `telegram ${this.operation} failed: ${String(this.cause)}`;
  }
}

export class ScheduleError extends Data.TaggedError("ScheduleError")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

export class WebError extends Data.TaggedError("WebError")<{
  readonly url: string;
  readonly reason: string;
}> {
  override get message() {
    return `${this.url}: ${this.reason}`;
  }
}

export class BlobError extends Data.TaggedError("BlobError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `blob ${this.operation} failed: ${String(this.cause)}`;
  }
}

export class ToolError extends Data.TaggedError("ToolError")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

export class ExecutorError extends Data.TaggedError("ExecutorError")<{
  readonly reason: string;
}> {
  override get message() {
    return `executor: ${this.reason}`;
  }
}

export class MediaError extends Data.TaggedError("MediaError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `media ${this.operation} failed: ${String(this.cause)}`;
  }
}

export class BrowserError extends Data.TaggedError("BrowserError")<{
  readonly url: string;
  readonly reason: string;
}> {
  override get message() {
    return `browser ${this.url}: ${this.reason}`;
  }
}

export class AccessDenied extends Data.TaggedError("AccessDenied")<{
  readonly reason: string;
}> {
  override get message() {
    return `access denied: ${this.reason}`;
  }
}

export class ActionError extends Data.TaggedError("ActionError")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

export class HookSecretMissing extends Data.TaggedError("HookSecretMissing")<{}> {
  override get message() {
    return "MIZOOK_WEBHOOK_SECRET is empty, so webhook links cannot be signed";
  }
}

/** Input a service refuses, with the reason in words a user or the model can act on. */
export class InvalidInput extends Data.TaggedError("InvalidInput")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

/**
 * A result that crosses a Durable Object call. A refusal travels as data, because an error
 * thrown across the call loses its tag.
 */
export type Refusable<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: string };

export const fromRefusable = <A>(result: Refusable<A>): Effect.Effect<A, InvalidInput> =>
  result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(new InvalidInput({ reason: result.reason }));
