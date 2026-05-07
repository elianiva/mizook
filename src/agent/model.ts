import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Env } from "../env";

export function createModel(env: Env) {
  const opencode = createOpenAICompatible({
    baseURL: "https://opencode.ai/zen/go/v1",
    name: "Opencode Go",
    apiKey: env.OPENCODE_GO_API_KEY,
    fetch: fetchWithTimeout(60_000),
  });
  return opencode.chatModel(env.OPENCODE_GO_MODEL ?? "deepseek-v4-flash");
}

function fetchWithTimeout(timeout: number) {
  return async (url: RequestInfo | URL, options?: RequestInit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        throw new Error(`Model request timed out after ${timeout}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}
