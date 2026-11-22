import { Context, type Effect } from "effect";
import type { CompletionError } from "./errors.ts";

export interface Turn {
  readonly role: "user" | "assistant";
  readonly parts: ReadonlyArray<string>;
}

export interface CompletionRequest {
  readonly system: string;
  readonly messages: ReadonlyArray<Turn>;
}

export class Summarizer extends Context.Service<
  Summarizer,
  {
    complete(request: CompletionRequest): Effect.Effect<string, CompletionError>;
  }
>()("@mizook/memory/Summarizer") {}
