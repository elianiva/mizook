import type { AssistantMessage, Message, Model, Api } from "@earendil-works/pi-ai";
import { CompletionError, Summarizer, type CompletionRequest } from "@mizook/memory";
import { Effect, Layer } from "effect";
import { Models } from "./models.ts";
import { agentTools } from "./tools.ts";
import { Usage } from "./usage.ts";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/** The conversation of one compaction, as pi-ai messages. Earlier replies are replayed as the model's own. */
const toMessages = (request: CompletionRequest, model: Model<Api>): Message[] =>
  request.messages.map((turn): Message => {
    const content = turn.parts.map((text) => ({ type: "text" as const, text }));
    if (turn.role === "user") return { role: "user", content, timestamp: Date.now() };
    return {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
      stopReason: "stop",
      timestamp: Date.now(),
    } satisfies AssistantMessage;
  });

/** The cheap model that writes the memory, over pi-ai. */
export const SummarizerLive = Layer.effect(
  Summarizer,
  Effect.gen(function* () {
    const { models, summary } = yield* Models;
    const usage = yield* Usage;
    return Summarizer.of({
      complete: (request) =>
        Effect.tryPromise({
          try: (signal) =>
            models.completeSimple(
              summary,
              {
                systemPrompt: request.system,
                messages: toMessages(request, summary),
                // Same tools as the turns, never called: the call then reads their cache entry.
                tools: agentTools,
              },
              { reasoning: summary.reasoning ? "xhigh" : undefined, signal, sessionId: "memory" },
            ),
          catch: (cause) => new CompletionError({ cause }),
        }).pipe(
          Effect.filterOrFail(
            (reply) => reply.stopReason !== "error" && reply.stopReason !== "aborted",
            (reply) =>
              new CompletionError({
                cause: reply.errorMessage ?? `model stopped: ${reply.stopReason}`,
              }),
          ),
          Effect.tap((reply) =>
            usage.record("memory", summary.id, reply.usage).pipe(Effect.ignore),
          ),
          Effect.map((reply) =>
            reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
          ),
        ),
    });
  }),
);
