import { Context, Effect, Layer } from "effect";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";
import type { Env } from "./env";
import { WorkersEnv } from "./workers-env";
import { ModelRequestError } from "./errors";

export const DEFAULT_MODEL = "mimo-v2.5";
const TIMEOUT_MS = 60_000;

// Native timeout via AbortSignal — no Effect.fiber-boundary wrapper around a
// fetch the AI SDK owns. This is the sole impl; the Model service wraps it and
// adds the summarize Effect surface.
export function createModel(env: Env, modelName?: string): LanguageModel {
  const opencode = createOpenAICompatible({
    baseURL: "https://opencode.ai/zen/go/v1",
    name: "Opencode Go",
    apiKey: env.OPENCODE_GO_API_KEY,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }),
  });
  return opencode.chatModel(modelName ?? env.OPENCODE_GO_MODEL ?? DEFAULT_MODEL);
}

type GenerateResult = Awaited<ReturnType<typeof generateText>>;

export class Model extends Context.Service<
  Model,
  {
    readonly chatModel: LanguageModel;
    summarize(prompt: string): Effect.Effect<string, ModelRequestError>;
  }
>()("mizook/Model") {
  static readonly layer = Layer.effect(Model)(
    Effect.gen(function* () {
      const { env } = yield* WorkersEnv;
      const chatModel = createModel(env);

      const summarize = (prompt: string) =>
        Effect.tryPromise({
          try: () =>
            generateText({
              prompt,
              model: chatModel,
              abortSignal: AbortSignal.timeout(TIMEOUT_MS),
            }) as Promise<GenerateResult>,
          catch: (cause) => new ModelRequestError({ cause }),
        }).pipe(Effect.map((r) => r.text));

      return Model.of({ chatModel, summarize });
    }),
  );
}
