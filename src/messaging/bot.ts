import { Effect, Schema } from "effect";
import { getAgentByName } from "agents";
import { Chat } from "chat";
import type { StateAdapter } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { TelegramAdapter } from "@chat-adapter/telegram";
import type { Env } from "../env";
import type { MizookAgent } from "../agent/mizook-agent";
import { AgentLookupError, AgentRpcError } from "../lib/errors";
import { createScopedLogger } from "../logger";

export function createBot(env: Env, state: StateAdapter) {
  const allowedUserIds = new Set(
    Schema.decodeSync(Schema.Array(Schema.NumberFromString))(
      env.TELEGRAM_ALLOWED_USER_IDS.split(/[\s,]+/).filter(Boolean),
    ).filter(Number.isSafeInteger),
  );
  const telegram = createTelegramAdapter({ botToken: env.BOT_TOKEN }) as TelegramAdapter;

  const bot = new Chat({
    userName: "mizook",
    adapters: {
      telegram,
    },
    state,
    dedupeTtlMs: 600_000,
  });

  bot.onDirectMessage((thread, message) => {
    const log = createScopedLogger({
      action: "on_direct_message",
      platform: "telegram",
      thread_id: thread.id,
      user_id: message.author.userId,
    });

    return Effect.gen(function* () {
      const userId = Number(message.author.userId);
      if (!allowedUserIds.has(userId)) {
        yield* Effect.tryPromise(() => thread.post("Access denied."));
        log.set({ detail: { access_denied: true } });
        return;
      }

      yield* Effect.tryPromise(() => thread.subscribe());

      const text = message.text.trim();
      if (text === "/start") {
        yield* Effect.tryPromise(() =>
          thread.post("Hello. I am Mizook. Send me a message and I will respond."),
        );
        log.set({ detail: { command: "start" } });
        return;
      }

      if (text === "/reset") {
        yield* handleReset(thread, telegram, env, log);
        log.set({ detail: { command: "reset" } });
        return;
      }

      yield* handleTelegramTurn(thread, message, telegram, env, log);
    }).pipe(
      Effect.tap(() => Effect.sync(() => log.emit({ message: "dm_handler_done" }))),
      Effect.catch((error) => {
        log.error(error);
        log.emit({ message: "dm_handler_error" });
        return Effect.logError("DM handler error", error);
      }),
      Effect.runPromise,
    );
  });

  bot.onNewMention((thread, message) => {
    const log = createScopedLogger({
      action: "on_mention",
      platform: "telegram",
      thread_id: thread.id,
      user_id: message.author.userId,
    });

    return Effect.gen(function* () {
      const userId = Number(message.author.userId);
      if (!allowedUserIds.has(userId)) {
        yield* Effect.tryPromise(() => thread.post("Access denied."));
        log.set({ detail: { access_denied: true } });
        return;
      }

      yield* Effect.tryPromise(() => thread.subscribe());
      yield* handleTelegramTurn(thread, message, telegram, env, log);
    }).pipe(
      Effect.tap(() => Effect.sync(() => log.emit({ message: "mention_handler_done" }))),
      Effect.catch((error) => {
        log.error(error);
        log.emit({ message: "mention_handler_error" });
        return Effect.logError("mention handler error", error);
      }),
      Effect.runPromise,
    );
  });

  bot.onSubscribedMessage((thread, message) => {
    const log = createScopedLogger({
      action: "on_subscribed_message",
      platform: "telegram",
      thread_id: thread.id,
      user_id: message.author.userId,
    });

    return Effect.gen(function* () {
      if (message.text.trim() === "/reset") {
        yield* handleReset(thread, telegram, env, log);
        log.set({ detail: { command: "reset" } });
        return;
      }

      yield* handleTelegramTurn(thread, message, telegram, env, log);
    }).pipe(
      Effect.tap(() => Effect.sync(() => log.emit({ message: "subscribed_handler_done" }))),
      Effect.catch((error) => {
        log.error(error);
        log.emit({ message: "subscribed_handler_error" });
        return Effect.logError("subscribed message handler error", error);
      }),
      Effect.runPromise,
    );
  });

  return bot;
}

const handleTelegramTurn = Effect.fnUntraced(function* (
  thread: import("chat").Thread,
  message: import("chat").Message,
  telegram: TelegramAdapter,
  env: Env,
  log: ReturnType<typeof createScopedLogger>,
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
  log.set({ detail: { turn_submitted: true, platform: "telegram", chat_id: Number(chatId) } });
});

const handleReset = Effect.fnUntraced(function* (
  thread: import("chat").Thread,
  telegram: TelegramAdapter,
  env: Env,
  log: ReturnType<typeof createScopedLogger>,
) {
  const { chatId } = telegram.decodeThreadId(thread.id);
  const agent = yield* Effect.tryPromise({
    try: () => getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId),
    catch: (cause) => new AgentLookupError({ cause }),
  });
  yield* Effect.tryPromise(() => agent.resetChat());
  yield* Effect.tryPromise(() => thread.post("Chat reset. Starting fresh."));
  log.set({ detail: { reset: true } });
});
