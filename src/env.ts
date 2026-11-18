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
  /** Workers AI: voice transcription, image descriptions and document conversion. */
  AI?: Ai;
  /** `<team>.cloudflareaccess.com`. The dashboard stays shut while this or the audience is empty. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** The built dashboard, served only after the Access check. */
  ASSETS?: Fetcher;
  PARALLEL_API_KEY?: string;
  EXA_API_KEY?: string;
}
