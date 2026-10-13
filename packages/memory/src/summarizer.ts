import { Context, type Effect } from "effect";
import type { CompletionError } from "./errors.ts";

/** One message of a compaction conversation. A user message is a list of parts, so a host can mark cache points between them. */
export interface Turn {
  readonly role: "user" | "assistant";
  readonly parts: ReadonlyArray<string>;
}

export interface CompletionRequest {
  readonly system: string;
  readonly messages: ReadonlyArray<Turn>;
}

/**
 * The cheap model that writes the lines (the design uses Claude Haiku at xhigh effort). The host
 * owns the call: it should send the same tools as the turns (never called) so a compaction reads
 * their prompt cache, and return the reply's text.
 */
export class Summarizer extends Context.Service<
  Summarizer,
  {
    complete(request: CompletionRequest): Effect.Effect<string, CompletionError>;
  }
>()("@mizook/memory/Summarizer") {}
