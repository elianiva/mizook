import { Bot } from "grammy";

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    await ctx.reply("Started!");
  });

  bot.on("message:text", async (ctx) => {
    await ctx.reply("It's working!");
  });

  return bot;
}
