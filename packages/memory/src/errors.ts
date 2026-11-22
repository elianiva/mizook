import { Data } from "effect";

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `store ${this.operation} failed: ${String(this.cause)}`;
  }
}

export class CompletionError extends Data.TaggedError("CompletionError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return `completion failed: ${String(this.cause)}`;
  }
}

export class ArchiveError extends Data.TaggedError("ArchiveError")<{
  readonly reason: string;
}> {
  override get message() {
    return `archive: ${this.reason}`;
  }
}

export class ZoomError extends Data.TaggedError("ZoomError")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}
