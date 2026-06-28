import type { Env } from "../../core/env";
import { getRuntime } from "../../core/runtime";
import { createBot } from "../../core/bot";

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const runtime = getRuntime(env);
  const bot = createBot(runtime, env);
  return bot.webhooks.telegram(request, { waitUntil: (p) => ctx.waitUntil(p) });
}
