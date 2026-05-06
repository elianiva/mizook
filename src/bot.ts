import { Chat } from "chat";
import type { StateAdapter } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { TelegramAdapter } from "@chat-adapter/telegram";
import { createDiscordAdapter } from "@chat-adapter/discord";
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
      discord: createDiscordAdapter({
        botToken: env.DISCORD_BOT_TOKEN,
        publicKey: env.DISCORD_PUBLIC_KEY,
        applicationId: env.DISCORD_APPLICATION_ID,
      }),
    },
    state,
    dedupeTtlMs: 600_000,
  });

  const telegram = bot.getAdapter("telegram") as TelegramAdapter;

  // ── Single registration per event type, route by thread ID ───────

  const dmResponses = [
    "you can't message me directly, silly :p",
    "aww, you tried to slide into my DMs~ no can do!",
    "hehe, i don't do DMs! try mentioning me in a server instead \u2728",
    "sorry, i'm shy. talk to me in a server ok? \ud83d\ude36",
    "direct messages? what are those? never heard of em \ud83e\udd2a",
    "nuh uh ~ no DMs allowed, that's like.. a rule or whatever!",
    "ehe~ you're cute for trying but i only respond in servers!",
    "whoops, wrong chat! try again in a server \ud83d\udc95",
    "no DMs teehee \ud83e\udd23",
    "sorry!! i have a strict no-dm policy,, it's nothing personal!",
    "you can't just DM me out of nowhere like that!! \ud83d\ude35\u200d\ud83d\udcab",
    "unfortunately i'm a server-only kinda bot, ya know? \ud83e\udd37\u200d\u2640\ufe0f",
    "i wish i could chat here but.. no can do!! \ud83d\ude05",
    "omg hii!! but um.. wrong place! try mentioning me in a server! \ud83d\ude0a",
    "DM denied !! i only exist in servers, sorry!! \ud83e\udd1e",
  ];

  bot.onDirectMessage(async (thread, message) => {
    if (thread.id.startsWith("discord:")) {
      const msg = dmResponses[Math.floor(Math.random() * dmResponses.length)];
      await thread.post(msg);
      return;
    }

    const userId = Number(message.author.userId);
    if (!allowedUserIds.has(userId)) {
      await thread.post("Access denied.");
      return;
    }

    await thread.subscribe();

    const text = message.text.trim();
    if (text === "/start") {
      await thread.post("Hello. I am Mizook. Send me a message and I will respond.");
      return;
    }

    if (text === "/reset") {
      await handleTelegramReset(thread);
      return;
    }

    await handleTelegramMessage(thread, message);
  });

  bot.onNewMention(async (thread, message) => {
    if (thread.id.startsWith("discord:")) {
      await thread.subscribe();
      await handleDiscordMessage(thread, message);
      return;
    }

    const userId = Number(message.author.userId);
    if (!allowedUserIds.has(userId)) {
      await thread.post("Access denied.");
      return;
    }

    await thread.subscribe();
    await handleTelegramMessage(thread, message);
  });

  bot.onSubscribedMessage(async (thread, message) => {
    if (thread.id.startsWith("discord:")) {
      await handleDiscordMessage(thread, message);
      return;
    }

    if (message.text.trim() === "/reset") {
      await handleTelegramReset(thread);
      return;
    }

    await handleTelegramMessage(thread, message);
  });

  // ── Internal helpers ─────────────────────────────────────────────

  async function handleTelegramMessage(thread: Thread, message: Message) {
    const { chatId } = telegram.decodeThreadId(thread.id);
    const agent = await getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId);
    await agent.submitTelegramMessage({
      chatId: Number(chatId),
      messageId: Number(message.id),
      text: message.text,
      thread: thread.toJSON(),
    });
  }

  async function handleTelegramReset(thread: Thread) {
    const { chatId } = telegram.decodeThreadId(thread.id);
    const agent = await getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId);
    await agent.resetChat();
    await thread.post("Chat reset. Starting fresh.");
  }

  async function handleDiscordMessage(thread: Thread, message: Message) {
    if (message.text.trim() === "/reset") {
      const agent = await getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, thread.id);
      await agent.resetChat();
      await thread.post("Chat reset. Starting fresh.");
      return;
    }

    const agent = await getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, thread.id);
    await agent.submitDiscordMessage({
      threadId: thread.id,
      messageId: String(message.id),
      text: message.text,
      thread: thread.toJSON(),
    });
  }

  return bot;
}
