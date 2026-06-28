import type { Env } from "../../core/env";
import { createBot } from "../../core/bot";
import { createCloudflareState } from "chat-state-cloudflare-do";
import { createTelegramChannel } from "./channel";

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const state = createCloudflareState({ namespace: env.CHAT_STATE });
  const bot = createBot({
    env,
    state,
    channels: { telegram: createTelegramChannel(env.BOT_TOKEN) },
  });
  return bot.webhooks.telegram(request, { waitUntil: (p) => ctx.waitUntil(p) });
}
