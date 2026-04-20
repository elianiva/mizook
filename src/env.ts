import type { MizookAgent } from "./agent";

export interface Env {
  AI: Ai;
  BOT_TOKEN: string;
  MIZOOK_AGENT: DurableObjectNamespace<MizookAgent>;
  MODEL_API_KEY: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
}
