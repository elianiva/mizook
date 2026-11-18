import { Data } from "effect";

/** pi-ai has no such provider or model. */
export class ModelNotFound extends Data.TaggedError("ModelNotFound")<{
  readonly provider: string;
  readonly model: string;
}> {
  override get message() {
    return `no model ${this.provider}/${this.model}`;
  }
}

/** pi-durable, or a call into it, failed. */
export class DurableError extends Data.TaggedError("DurableError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `${this.operation} failed: ${String(this.cause)}`;
  }
}

/** The bot's own bookkeeping could not be read or written. */
export class StateError extends Data.TaggedError("StateError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `state ${this.operation} failed: ${String(this.cause)}`;
  }
}

/** Telegram, through the Chat SDK, failed. */
export class TelegramError extends Data.TaggedError("TelegramError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `telegram ${this.operation} failed: ${String(this.cause)}`;
  }
}

/** A schedule the agent asked for cannot be made. The reason goes back to the agent. */
export class ScheduleError extends Data.TaggedError("ScheduleError")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

/** A web request failed, or the page was refused. */
export class WebError extends Data.TaggedError("WebError")<{
  readonly url: string;
  readonly reason: string;
}> {
  override get message() {
    return `${this.url}: ${this.reason}`;
  }
}

/** The blob store (R2) failed. */
export class BlobError extends Data.TaggedError("BlobError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `blob ${this.operation} failed: ${String(this.cause)}`;
  }
}

/** The agent asked for something a tool cannot do: a bad name, a file too large, nothing by that name. The reason goes back to the agent. */
export class ToolError extends Data.TaggedError("ToolError")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

/** Executor (an MCP endpoint) refused or failed. The reason goes back to the agent. */
export class ExecutorError extends Data.TaggedError("ExecutorError")<{
  readonly reason: string;
}> {
  override get message() {
    return `executor: ${this.reason}`;
  }
}

/** Workers AI could not read an attachment. */
export class MediaError extends Data.TaggedError("MediaError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `media ${this.operation} failed: ${String(this.cause)}`;
  }
}

/** A dashboard request did not carry a valid Cloudflare Access token. */
export class AccessDenied extends Data.TaggedError("AccessDenied")<{
  readonly reason: string;
}> {
  override get message() {
    return `access denied: ${this.reason}`;
  }
}
