import type { ChatAgent } from "./chat-agent.ts";
import type { Hub } from "./hub.ts";

/** The Worker's bindings: what `alchemy.run.ts` declares. */
export interface Env {
  ChatAgent: DurableObjectNamespace<ChatAgent>;
  Hub: DurableObjectNamespace<Hub>;
  EXECUTOR_URL?: string;
  EXECUTOR_TOKEN?: string;
  BOT_TOKEN: string;
  MIZOOK_WEBHOOK_SECRET: string;
  DEEPSEEK_API_KEY: string;
  TELEGRAM_ALLOWED_USER_IDS?: string;
  BOT_USERNAME?: string;
  AGENT_NAME?: string;
  INSTRUCTIONS?: string;
  MODEL?: string;
  SUMMARY_MODEL?: string;
  TIMEZONE?: string;
  SEARCH_PROVIDERS?: string;
  PUBLIC_URL?: string;
  BUDGET_DAILY?: string;
  Files: R2Bucket;
  PARALLEL_API_KEY?: string;
  EXA_API_KEY?: string;
}
