import { Effect } from "effect";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Env } from "../env";
import { ModelTimeoutError, ModelRequestError } from "../lib/errors";

export function createModel(env: Env) {
  const opencode = createOpenAICompatible({
    baseURL: "https://opencode.ai/zen/go/v1",
    name: "Opencode Go",
    apiKey: env.OPENCODE_GO_API_KEY,
    fetch: (url, options) =>
      Effect.runPromise(
        Effect.tryPromise({
          try: (signal) => fetch(url, { ...options, signal }) as Promise<Response>,
          catch: (cause) => new ModelRequestError({ cause }),
        }).pipe(
          Effect.timeout(60_000),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(new ModelTimeoutError({ timeoutMs: 60_000 })),
          ),
        ),
      ),
  });
  return opencode.chatModel(env.OPENCODE_GO_MODEL ?? "deepseek-v4-flash");
}
