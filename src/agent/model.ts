import { Config, Effect } from "effect";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Env } from "../env";
import { ModelTimeoutError, ModelRequestError } from "../lib/errors";
import { createScopedLogger } from "../logger";

export const modelConfig = Config.string("OPENCODE_GO_MODEL").pipe(
  Config.withDefault("deepseek-v4-flash"),
);

export const DEFAULT_MODEL = "deepseek-v4-flash";

export function createModel(env: Env) {
  const opencode = createOpenAICompatible({
    baseURL: "https://opencode.ai/zen/go/v1",
    name: "Opencode Go",
    apiKey: env.OPENCODE_GO_API_KEY,
    fetch: (url, options) => {
      const log = createScopedLogger({ action: "model_request" });
      return Effect.tryPromise({
        try: (signal) => fetch(url, { ...options, signal }) as Promise<Response>,
        catch: (cause) => {
          log.set({ detail: { error: cause instanceof Error ? cause.message : String(cause) } });
          return new ModelRequestError({ cause });
        },
      }).pipe(
        Effect.timeout(60_000),
        Effect.catchTag("TimeoutError", () => {
          log.set({ detail: { error: "timeout", timeoutMs: 60_000 } });
          return Effect.fail(new ModelTimeoutError({ timeoutMs: 60_000 }));
        }),
        Effect.tap((response) =>
          Effect.sync(() => log.set({ detail: { status: response.status } })),
        ),
        Effect.ensuring(Effect.sync(() => log.emit({ message: "model_request_done" }))),
        Effect.runPromise,
      );
    },
  });
  return opencode.chatModel(env.OPENCODE_GO_MODEL ?? DEFAULT_MODEL);
}
