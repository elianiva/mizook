import { webhookCallback } from "grammy";
import { getAgentByName } from "agents";
import { getTelegramBot } from "./telegram-client";
import type { Env } from "./env";
import type { RequestLogger } from "evlog";
import { createScopedLogger } from "./logger";

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
        const l = createScopedLogger({ action: "access_denied", user_id: ctx.from?.id });
        await ctx.reply("Access denied.");
        l.emit({ result: "denied" });
        return;
      }

      await next();
    });

    bot.command("start", async (ctx) => {
      const l = createScopedLogger({
        action: "command",
        command: "/start",
        user_id: ctx.from?.id,
        chat_id: ctx.chat?.id,
      });
      await ctx.reply("Hello. I am Mizook. Send me a message and I will respond.");
      l.emit({ result: "ok" });
    });

    bot.on("message:text", async (ctx) => {
      const l = createScopedLogger({
        action: "message",
        user_id: ctx.from?.id,
        chat_id: ctx.chat.id,
        message_id: ctx.message.message_id,
      });

      try {
        l.set({ phase: "routing_agent" });
        const agent = await getAgentByName(env.MIZOOK_AGENT, String(ctx.chatId));

        l.set({ phase: "submitting_to_agent" });
        await agent.submitTelegramMessage({
          chatId: ctx.chat.id,
          messageId: ctx.message.message_id,
          text: ctx.message.text,
        });

        l.emit({ result: "submitted" });
      } catch (err) {
        l.set({ error: err instanceof Error ? err.message : String(err) });
        l.emit({ result: "error" });
      }
    });

    initialized = true;
  }

  return bot;
}

export async function handleTelegramWebhook(request: Request, env: Env, log: RequestLogger) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (header !== secret) {
      log.set({ action: "webhook", reason: "unauthorized" });
      log.emit({ status: 401 });
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const response = await webhookCallback(getBot(env), "cloudflare-mod")(request);
    log.set({ action: "webhook" });
    log.emit({ status: response.status });
    return response;
  } catch (err) {
    log.set({ action: "webhook", error: err instanceof Error ? err.message : String(err) });
    log.emit({ status: 500 });
    throw err;
  }
}
