import { Chat } from "chat";
import type { StateAdapter } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { TelegramAdapter } from "@chat-adapter/telegram";
import { createDiscordAdapter } from "@chat-adapter/discord";
import type { Env } from "../env";
import {
  handleDirectMessage,
  handleTelegramMessage,
  handleTelegramReset,
  handleDiscordMessage,
} from "./handlers";

function parseAllowedUserIds(value: string): Set<number> {
  const ids = new Set<number>();
  for (const token of value.split(/[\s,]+/)) {
    if (!token) continue;
    const id = Number(token);
    if (Number.isSafeInteger(id)) ids.add(id);
  }
  return ids;
}

export function createBot(env: Env, state: StateAdapter) {
  const allowedUserIds = parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS);
  const telegram = createTelegramAdapter({ botToken: env.BOT_TOKEN }) as TelegramAdapter;

  const bot = new Chat({
    userName: "mizook",
    adapters: {
      telegram,
      discord: createDiscordAdapter({
        botToken: env.DISCORD_BOT_TOKEN,
        publicKey: env.DISCORD_PUBLIC_KEY,
        applicationId: env.DISCORD_APPLICATION_ID,
      }),
    },
    state,
    dedupeTtlMs: 600_000,
  });

  bot.onDirectMessage(async (thread, message) => {
    await handleDirectMessage(thread, message, telegram, allowedUserIds, env);
  });

  bot.onNewMention(async (thread, message) => {
    if (thread.id.startsWith("discord:")) {
      await thread.subscribe();
      await handleDiscordMessage(thread, message, env);
      return;
    }

    const userId = Number(message.author.userId);
    if (!allowedUserIds.has(userId)) {
      await thread.post("Access denied.");
      return;
    }

    await thread.subscribe();
    await handleTelegramMessage(thread, message, telegram, env);
  });

  bot.onSubscribedMessage(async (thread, message) => {
    if (thread.id.startsWith("discord:")) {
      await handleDiscordMessage(thread, message, env);
      return;
    }

    if (message.text.trim() === "/reset") {
      await handleTelegramReset(thread, telegram, env);
      return;
    }

    await handleTelegramMessage(thread, message, telegram, env);
  });

  return bot;
}
