import { webhookCallback } from "grammy";
import { getTelegramBot } from "./telegram-client";
import type { Env } from "./agent";
import { log } from "evlog";

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

    log.info({ action: "bot_init", phase: "applying whitelist middleware" });
    bot.use(async (ctx, next) => {
      if (ctx.from?.id == null || !allowedUserIds.has(ctx.from.id)) {
        await ctx.reply("Access denied.");
        return;
      }

      await next();
    });

    log.info({ action: "bot_init", phase: "registering start command" });
    bot.command("start", async (ctx) => {
      log.info({ action: "bot_command", phase: "responding /start" });
      await ctx.reply("Hello. Send me a message.");
    });

    log.info({ action: "bot_init", phase: "registering message handler" });
    bot.on("message:text", async (ctx) => {
      try {
        log.info({ action: "bot_response", phase: "getting DO agent" });
        const agentId = env.MIZOOK_AGENT.idFromString(String(ctx.chatId));
        const agent = env.MIZOOK_AGENT.get(agentId);

        log.info({ action: "bot_response", phase: "responding to message" });
        await agent.submitTelegramMessage({
          chatId: ctx.chat.id,
          messageId: ctx.message.message_id,
          text: ctx.message.text,
        });
      } catch (err) {
        log.error({ action: "bot_response", phase: "error", error: err });
      }
    });

    initialized = true;
  }

  return bot;
}

export async function handleTelegramWebhook(request: Request, env: Env) {
  return webhookCallback(getBot(env), "cloudflare-mod")(request);
}
