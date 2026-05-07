import type { MizookAgent } from "./agent/mizook-agent";
import type { ChatStateDO } from "chat-state-cloudflare-do";
import type { DiscordGatewayDO } from "discord-gateway-cloudflare-do";

export interface Env {
  AI: Ai;
  BOT_TOKEN: string;
  MIZOOK_AGENT: DurableObjectNamespace<MizookAgent>;
  CHAT_STATE: DurableObjectNamespace<ChatStateDO>;
  OPENCODE_GO_API_KEY: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
  OPENCODE_GO_MODEL?: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_GATEWAY_SECRET: string;
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGatewayDO>;
}
