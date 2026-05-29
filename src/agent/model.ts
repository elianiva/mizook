import { Config, Effect } from "effect";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Env } from "../env";
import { ModelTimeoutError, ModelRequestError } from "../lib/errors";
import { createScopedLogger } from "../logger";

export const DEFAULT_MODEL = "mimo-v2.5";

const TIMEOUT_MS = 60_000;

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
          if (cause instanceof Error) log.error(cause);
          else log.set({ detail: { error: String(cause) } });
          return new ModelRequestError({ cause });
        },
      }).pipe(
        Effect.timeout(TIMEOUT_MS),
        Effect.catchTag("TimeoutError", () => {
          log.set({ detail: { error: "timeout", timeoutMs: TIMEOUT_MS } });
          return Effect.fail(new ModelTimeoutError({ timeoutMs: TIMEOUT_MS }));
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
