import type { MizookAgent } from "./agent";
import type { ChatStateDO } from "chat-state-cloudflare-do";

export interface Env {
  AI: Ai;
  BOT_TOKEN: string;
  MIZOOK_AGENT: DurableObjectNamespace<MizookAgent>;
  CHAT_STATE: DurableObjectNamespace<ChatStateDO>;
  OPENCODE_GO_API_KEY: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
  OPENCODE_GO_MODEL?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}
