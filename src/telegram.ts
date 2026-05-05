import { webhookCallback } from "grammy";
import { getTelegramBot } from "./telegram-client";
import type { Env } from "./env";
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
      await ctx.reply("Hello. I am Mizook. Send me a message and I will respond.");
    });

    bot.command("setwebhook", async (ctx) => {
      log.info({ action: "bot_command", phase: "responding /setwebhook" });
      const workerUrl = ctx.match.trim();
      if (!workerUrl) {
        await ctx.reply(
          "Usage: /setwebhook https://your-worker.your-subdomain.workers.dev\n\n" +
          "This registers the Telegram webhook URL. Make sure the worker is deployed first.",
        );
        return;
      }
      try {
        const webhookUrl = `${workerUrl.replace(/\/+$/, "")}/telegram`;
        const secret = env.TELEGRAM_WEBHOOK_SECRET;
        const body: Record<string, string> = { url: webhookUrl };
        if (secret) body.secret_token = secret;

        const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (json.ok) {
          await ctx.reply(`Webhook set to ${webhookUrl}`);
        } else {
          await ctx.reply(`Failed: ${JSON.stringify(json)}`);
        }
      } catch (err) {
        await ctx.reply(`Error: ${err.message}`);
      }
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
        log.error({
          action: "bot_response",
          phase: "error",
          error: err.message ?? "Unknown Error",
        });
      }
    });

    initialized = true;
  }

  return bot;
}

export async function handleTelegramWebhook(request: Request, env: Env) {
  // Verify webhook secret token if configured
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (header !== secret) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  return webhookCallback(getBot(env), "cloudflare-mod")(request);
}
