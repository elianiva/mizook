import type { TelegramAdapter } from "@chat-adapter/telegram";
import { getAgentByName } from "agents";
import type { Thread, Message } from "chat";
import type { Env } from "../env";
import type { MizookAgent } from "../agent/mizook-agent";
import { dmResponses } from "../constants/dm-responses";

export async function handleTelegramMessage(
  thread: Thread,
  message: Message,
  telegram: TelegramAdapter,
  env: Env,
) {
  const { chatId } = telegram.decodeThreadId(thread.id);
  const agent = await getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId);
  await agent.submitTelegramMessage({
    chatId: Number(chatId),
    messageId: Number(message.id),
    text: message.text,
    thread: thread.toJSON(),
  });
}

export async function handleTelegramReset(thread: Thread, telegram: TelegramAdapter, env: Env) {
  const { chatId } = telegram.decodeThreadId(thread.id);
  const agent = await getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId);
  await agent.resetChat();
  await thread.post("Chat reset. Starting fresh.");
}

export async function handleDiscordMessage(thread: Thread, message: Message, env: Env) {
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

export async function handleDirectMessage(
  thread: Thread,
  message: Message,
  telegram: TelegramAdapter,
  allowedUserIds: Set<number>,
  env: Env,
) {
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
    await handleTelegramReset(thread, telegram, env);
    return;
  }

  await handleTelegramMessage(thread, message, telegram, env);
}
