import { Bot } from "grammy";

const bots = new Map<string, Bot>();

export function getTelegramBot(token: string) {
  let bot = bots.get(token);
  if (!bot) {
    bot = new Bot(token);
    bots.set(token, bot);
  }
  return bot;
}

export function getTelegramApi(token: string) {
  return getTelegramBot(token).api;
}
