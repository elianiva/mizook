import { Effect } from "effect";
import { getAgentByName } from "agents";
import { Chat } from "chat";
import type { StateAdapter } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { TelegramAdapter } from "@chat-adapter/telegram";
import { createDiscordAdapter } from "@chat-adapter/discord";
import type { Env } from "../env";
import type { MizookAgent } from "../agent/mizook-agent";
import { dmResponses } from "../constants/dm-responses";
import { AgentLookupError, AgentRpcError } from "../lib/errors";

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

  bot.onDirectMessage((thread, message) =>
    Effect.gen(function* () {
      if (thread.id.startsWith("discord:")) {
        const msg = dmResponses[Math.floor(Math.random() * dmResponses.length)];
        yield* Effect.tryPromise(() => thread.post(msg));
        return;
      }

      const userId = Number(message.author.userId);
      if (!allowedUserIds.has(userId)) {
        yield* Effect.tryPromise(() => thread.post("Access denied."));
        return;
      }

      yield* Effect.tryPromise(() => thread.subscribe());

      const text = message.text.trim();
      if (text === "/start") {
        yield* Effect.tryPromise(() =>
          thread.post("Hello. I am Mizook. Send me a message and I will respond."),
        );
        return;
      }

      if (text === "/reset") {
        yield* handleReset(thread, telegram, env);
        return;
      }

      yield* handleTelegramTurn(thread, message, telegram, env);
    }).pipe(
      Effect.catch((error) => Effect.sync(() => console.error("DM handler error:", error))),
      Effect.runPromise,
    ),
  );

  bot.onNewMention((thread, message) =>
    Effect.gen(function* () {
      if (thread.id.startsWith("discord:")) {
        yield* Effect.tryPromise(() => thread.subscribe());
        yield* handleDiscordTurn(thread, message, env);
        return;
      }

      const userId = Number(message.author.userId);
      if (!allowedUserIds.has(userId)) {
        yield* Effect.tryPromise(() => thread.post("Access denied."));
        return;
      }

      yield* Effect.tryPromise(() => thread.subscribe());
      yield* handleTelegramTurn(thread, message, telegram, env);
    }).pipe(
      Effect.catch((error) => Effect.sync(() => console.error("mention handler error:", error))),
      Effect.runPromise,
    ),
  );

  bot.onSubscribedMessage((thread, message) =>
    Effect.gen(function* () {
      if (thread.id.startsWith("discord:")) {
        yield* handleDiscordTurn(thread, message, env);
        return;
      }

      if (message.text.trim() === "/reset") {
        yield* handleReset(thread, telegram, env);
        return;
      }

      yield* handleTelegramTurn(thread, message, telegram, env);
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => console.error("subscribed message handler error:", error)),
      ),
      Effect.runPromise,
    ),
  );

  return bot;
}

const handleTelegramTurn = Effect.fnUntraced(function* (
  thread: import("chat").Thread,
  message: import("chat").Message,
  telegram: TelegramAdapter,
  env: Env,
) {
  const { chatId } = telegram.decodeThreadId(thread.id);
  const agent = yield* Effect.tryPromise({
    try: () => getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId),
    catch: (cause) => new AgentLookupError({ cause }),
  });
  yield* Effect.tryPromise({
    try: () =>
      agent.submitTelegramMessage({
        chatId: Number(chatId),
        messageId: Number(message.id),
        text: message.text,
        thread: thread.toJSON(),
      }),
    catch: (cause) => new AgentRpcError({ cause }),
  });
});

const handleDiscordTurn = Effect.fnUntraced(function* (
  thread: import("chat").Thread,
  message: import("chat").Message,
  env: Env,
) {
  if (message.text.trim() === "/reset") {
    const agent = yield* Effect.tryPromise({
      try: () => getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, thread.id),
      catch: (cause) => new AgentLookupError({ cause }),
    });
    yield* Effect.tryPromise(() => agent.resetChat());
    yield* Effect.tryPromise(() => thread.post("Chat reset. Starting fresh."));
    return;
  }

  const agent = yield* Effect.tryPromise({
    try: () => getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, thread.id),
    catch: (cause) => new AgentLookupError({ cause }),
  });
  yield* Effect.tryPromise({
    try: () =>
      agent.submitDiscordMessage({
        threadId: thread.id,
        messageId: String(message.id),
        text: message.text,
        thread: thread.toJSON(),
      }),
    catch: (cause) => new AgentRpcError({ cause }),
  });
});

const handleReset = Effect.fnUntraced(function* (
  thread: import("chat").Thread,
  telegram: TelegramAdapter,
  env: Env,
) {
  const { chatId } = telegram.decodeThreadId(thread.id);
  const agent = yield* Effect.tryPromise({
    try: () => getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId),
    catch: (cause) => new AgentLookupError({ cause }),
  });
  yield* Effect.tryPromise(() => agent.resetChat());
  yield* Effect.tryPromise(() => thread.post("Chat reset. Starting fresh."));
});
