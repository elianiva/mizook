import { Chat } from "chat";
import type { StateAdapter } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { TelegramAdapter } from "@chat-adapter/telegram";
import { getAgentByName } from "agents";
import type { Env } from "./env";
import type { Thread, Message } from "chat";
import type { MizookAgent } from "./agent";

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

  const bot = new Chat({
    userName: "mizook",
    adapters: {
      telegram: createTelegramAdapter({
        botToken: env.BOT_TOKEN,
      }),
    },
    state,
    dedupeTtlMs: 600_000,
  });

  const telegram = bot.getAdapter("telegram") as TelegramAdapter;

  const handleMessage = async (thread: Thread, message: Message) => {
    const { chatId } = telegram.decodeThreadId(thread.id);
    const agent = await getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId);
    await agent.submitTelegramMessage({
      chatId: Number(chatId),
      messageId: Number(message.id),
      text: message.text,
    });
  };

  bot.onDirectMessage(async (thread, message) => {
    const userId = Number(message.author.userId);
    if (!allowedUserIds.has(userId)) {
      await thread.post("Access denied.");
      return;
    }

    await thread.subscribe();

    if (message.text.trim() === "/start") {
      await thread.post("Hello. I am Mizook. Send me a message and I will respond.");
      return;
    }

    await handleMessage(thread, message);
  });

  bot.onNewMention(async (thread, message) => {
    const userId = Number(message.author.userId);
    if (!allowedUserIds.has(userId)) {
      await thread.post("Access denied.");
      return;
    }

    await thread.subscribe();
    await handleMessage(thread, message);
  });

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.text.trim() === "/reset") {
      const { chatId } = telegram.decodeThreadId(thread.id);
      const agent = await getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId);
      await agent.resetChat();
      await thread.post("Chat reset. Starting fresh.");
      return;
    }

    await handleMessage(thread, message);
  });

  return bot;
}
