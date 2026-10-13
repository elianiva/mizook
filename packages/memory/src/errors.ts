import { Data } from "effect";

/** The log could not be read or written. */
export class StoreError extends Data.TaggedError("StoreError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `store ${this.operation} failed: ${String(this.cause)}`;
  }
}

/** The model call that writes a line failed, or answered nothing. */
export class CompletionError extends Data.TaggedError("CompletionError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return `completion failed: ${String(this.cause)}`;
  }
}

/** A tool asked for something the chat does not have: an id out of range, or `n` not a power of 2. */
export class ZoomError extends Data.TaggedError("ZoomError")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}
