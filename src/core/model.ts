import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";
import type { Env } from "./env";

export const DEFAULT_MODEL = "mimo-v2.5";
const TIMEOUT_MS = 60_000;

export function createModel(env: Env, modelName?: string): LanguageModel {
  const opencode = createOpenAICompatible({
    baseURL: "https://opencode.ai/zen/go/v1",
    name: "Opencode Go",
    apiKey: env.OPENCODE_GO_API_KEY,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }),
  });
  return opencode.chatModel(modelName ?? env.OPENCODE_GO_MODEL ?? DEFAULT_MODEL);
}

export async function summarize(env: Env, prompt: string): Promise<string> {
  const model = createModel(env);
  const { text } = await generateText({
    prompt,
    model,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return text;
}
