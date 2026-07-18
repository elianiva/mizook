import type { Env } from "../../core/env";
import { getRuntime } from "../../core/runtime";
import { createBot } from "../../core/bot";
import { createTelegramChannel } from "./channel";

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const runtime = getRuntime(env);
  const channel = createTelegramChannel(env.BOT_TOKEN);
  const bot = createBot(runtime, env, channel, (p) => ctx.waitUntil(p));
  return bot.webhooks.telegram(request);
}
