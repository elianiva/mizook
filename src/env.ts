import type { AgentObject } from "./agent-object.ts";
import type { AutomationsObject } from "./automations-object.ts";
import type { Hub } from "./hub.ts";

export interface Env {
  AgentObject: DurableObjectNamespace<AgentObject>;
  Hub: DurableObjectNamespace<Hub>;
  Automations: DurableObjectNamespace<AutomationsObject>;
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
  AI?: Ai;
  BROWSER?: BrowserRun;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ASSETS?: Fetcher;
  PARALLEL_API_KEY?: string;
  EXA_API_KEY?: string;
}
