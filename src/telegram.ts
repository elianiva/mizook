import { webhookCallback } from "grammy";
import { getTelegramBot } from "./telegram-client";
import type { Env, ReiAgent } from "./agent";

let bot: ReturnType<typeof getTelegramBot> | undefined;

function getBot(env: Env) {
  bot ??= getTelegramBot(env.BOT_TOKEN);

  bot.command("start", async (ctx) => {
    await ctx.reply("Hello. Send me a message.");
  });

  bot.on("message:text", async (ctx) => {
    const agentId = env.REI_AGENT.idFromName(String(ctx.chat.id));
    const agent = env.REI_AGENT.get(agentId) as unknown as ReiAgent;

    await agent.submitTelegramMessage({
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      text: ctx.message.text,
    });
  });

  return bot;
}

export async function handleTelegramWebhook(request: Request, env: Env) {
  return webhookCallback(getBot(env), "cloudflare-mod")(request);
}
