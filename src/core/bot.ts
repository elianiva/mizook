import { Effect, Schema } from "effect";
import { Chat } from "chat";
import { getAgentByName } from "agents";
import type { Env } from "./env";
import type { MizookAgent } from "./agent";
import type { StateAdapter, Thread, Message, SlashCommandEvent } from "chat";
import type { ChannelInterface } from "./channel";
import { AgentLookupError, AgentRpcError } from "./errors";
import { createScopedLogger } from "./logger";

interface BotConfig {
  env: Env;
  state: StateAdapter;
  channels: Record<string, ChannelInterface>;
  dedupeTtlMs?: number;
}

export function createBot(config: BotConfig) {
  const { env, state, channels, dedupeTtlMs = 600_000 } = config;

  const adapters = Object.fromEntries(
    Object.entries(channels).map(([name, ch]) => [name, ch.adapter]),
  );

  const bot = new Chat({
    userName: "mizook",
    adapters,
    state,
    dedupeTtlMs,
  });

  const resolveChannel = (threadId: string) => {
    const channelName = threadId.split(":")[0];
    const channel = channels[channelName];
    if (!channel) throw new Error(`Unknown channel: ${channelName}`);
    return { channel, channelName };
  };

  const handleTurn = Effect.fnUntraced(function* (
    thread: Thread,
    message: Message,
    log: ReturnType<typeof createScopedLogger>,
  ) {
    const { channel, channelName } = resolveChannel(thread.id);
    const { chatId } = channel.decodeThreadId(thread.id);
    // chatId is used for DO routing — keeps the same agent instance per chat
    const agent = yield* Effect.tryPromise({
      try: () => getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId),
      catch: (cause) => new AgentLookupError({ cause }),
    });
    yield* Effect.tryPromise({
      try: () =>
        agent.submitTurn({
          thread: thread.toJSON(),
          chatId,
          messageId: message.id,
          text: message.text,
          channelType: channelName,
        }),
      catch: (cause) => new AgentRpcError({ cause }),
    });
    log.set({ detail: { turn_submitted: true, thread_id: thread.id, chat_id: chatId } });
  });

  const makeHandler = (opts: {
    action: string;
    checkAccess: boolean;
    handleStart: boolean;
    allowedUserIds: Set<number>;
  }) => {
    return (thread: Thread, message: Message) => {
      const log = createScopedLogger({
        action: opts.action,
        thread_id: thread.id,
        user_id: message.author.userId,
      });

      return Effect.gen(function* () {
        if (opts.checkAccess) {
          const uid = Number(message.author.userId);
          if (!opts.allowedUserIds.has(uid)) {
            yield* Effect.tryPromise(() => thread.post("Access denied."));
            log.set({ detail: { access_denied: true } });
            return;
          }
        }

        yield* Effect.tryPromise(() => thread.subscribe());

        const text = message.text.trim();

        if (opts.handleStart && text === "/start") {
          yield* Effect.tryPromise(() =>
            thread.post("Hello. I am Mizook. Send me a message and I will respond."),
          );
          log.set({ detail: { command: "start" } });
          return;
        }

        if (text === "/reset") {
          yield* handleReset(thread, log);
          log.set({ detail: { command: "reset" } });
          return;
        }

        yield* handleTurn(thread, message, log);
      }).pipe(
        Effect.tap(() => Effect.sync(() => log.emit({ message: `${opts.action}_done` }))),
        Effect.catch((error) => {
          log.error(error);
          log.emit({ message: `${opts.action}_error` });
          return Effect.logError(`${opts.action} error`, error);
        }),
        Effect.runPromise,
      );
    };
  };

  const handleReset = Effect.fnUntraced(function* (
    thread: Thread,
    log: ReturnType<typeof createScopedLogger>,
  ) {
    const { channel, channelName } = resolveChannel(thread.id);
    const { chatId } = channel.decodeThreadId(thread.id);
    // Use chatId to find the same DO instance the agent is using per-turn
    const agent = yield* Effect.tryPromise({
      try: () => getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId),
      catch: (cause) => new AgentLookupError({ cause }),
    });
    yield* Effect.tryPromise(() => agent.resetChat()).pipe(
      Effect.tap(() => Effect.tryPromise(() => thread.post("Chat reset. Starting fresh."))),
      Effect.tapError((error) =>
        Effect.tryPromise(() =>
          thread.post(`Reset failed: ${error instanceof Error ? error.message : String(error)}`),
        ),
      ),
    );
    log.set({ detail: { reset: true, chat_id: chatId, channel: channelName } });
  });

  // Parsed at module scope — stable across requests since env vars rarely change.
  // A cold start is required to pick up new values, which is fine for an allowlist.
  const parseAllowedIds = (raw: string) => {
    try {
      return new Set(
        Schema.decodeSync(Schema.Array(Schema.NumberFromString))(
          raw.split(/[\s,]+/).filter(Boolean),
        ).filter(Number.isSafeInteger),
      );
    } catch {
      return new Set<number>();
    }
  };

  const allowedUserIds = parseAllowedIds(env.TELEGRAM_ALLOWED_USER_IDS);

  bot.onDirectMessage(
    makeHandler({ action: "on_dm", checkAccess: true, handleStart: true, allowedUserIds }),
  );
  bot.onNewMention(
    makeHandler({ action: "on_mention", checkAccess: true, handleStart: false, allowedUserIds }),
  );
  bot.onSubscribedMessage(
    makeHandler({
      action: "on_subscribed",
      checkAccess: false,
      handleStart: false,
      allowedUserIds,
    }),
  );

  bot.onSlashCommand(["start", "reset"], async (event: SlashCommandEvent) => {
    const log = createScopedLogger({
      action: `slash_${event.command}`,
      user_id: event.user.userId,
      channel_id: event.channel.id,
    });

    try {
      const uid = Number(event.user.userId);
      if (!allowedUserIds.has(uid)) {
        await event.channel.post("Access denied.");
        log.set({ detail: { access_denied: true } });
        log.emit({ message: "slash_access_denied" });
        return;
      }

      if (event.command === "/start") {
        await event.channel.post("Hello. I am Mizook. Send me a message and I will respond.");
        log.set({ detail: { command: "start" } });
        log.emit({ message: "slash_start_done" });
        return;
      }

      // /reset
      const { channel, channelName } = resolveChannel(event.channel.id);
      const { chatId } = channel.decodeThreadId(event.channel.id);
      const agent = await getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId);
      try {
        await agent.resetChat();
        await event.channel.post("Chat reset. Starting fresh.");
      } catch (error) {
        await event.channel.post(
          `Reset failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      log.set({ detail: { reset: true, chat_id: chatId, channel: channelName } });
      log.emit({ message: "slash_reset_done" });
    } catch (error) {
      log.error(error instanceof Error ? error : new Error(String(error)));
      log.emit({ message: `slash_${event.command}_error` });
    }
  });

  return bot;
}
