import { webhookCallback } from "grammy";
import { getTelegramBot } from "./telegram-client";
import type { Env, MizookAgent } from "./agent";

let bot: ReturnType<typeof getTelegramBot> | undefined;
let initialized = false;

function parseAllowedUserIds(value: string): Set<number> {
  const ids = new Set<number>();

  for (const token of value.split(/[\s,]+/)) {
    if (!token) continue;
    const id = Number(token);
    if (Number.isSafeInteger(id)) ids.add(id);
  }

  return ids;
}

function getBot(env: Env) {
  bot ??= getTelegramBot(env.BOT_TOKEN);

  if (!initialized) {
    const allowedUserIds = parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS);

    bot.use(async (ctx, next) => {
      if (ctx.from?.id == null || !allowedUserIds.has(ctx.from.id)) {
        await ctx.reply("Access denied.");
        return;
      }

      await next();
    });

    bot.command("start", async (ctx) => {
      await ctx.reply("Hello. Send me a message.");
    });

    bot.on("message:text", async (ctx) => {
      const agentId = env.MIZOOK_AGENT.idFromString(String(ctx.chat.id));
      const agent = env.MIZOOK_AGENT.get(agentId) as unknown as MizookAgent;

      await agent.submitTelegramMessage({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        text: ctx.message.text,
      });
    });

    initialized = true;
  }

  return bot;
}

export async function handleTelegramWebhook(request: Request, env: Env) {
  return webhookCallback(getBot(env), "cloudflare-mod")(request);
}
