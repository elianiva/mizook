import { Effect } from "effect";
import { Chat } from "chat";
import type { Thread, Message, SlashCommandEvent } from "chat";
import { createCloudflareState } from "chat-state-cloudflare-do";
import { getAgentByName } from "agents";
import type { Env } from "./env";
import { WorkersEnv } from "./workers-env";
import type { MizookAgent } from "./agent";
import type { AppRuntime, AppServices } from "./runtime";
import { AgentRpcError } from "./errors";
import type { Channel } from "./channel";
import { parseAllowedIds } from "./allowed-users";

const rateLimits = new Map<string, { tokens: number; resetAt: number }>();
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(chatId: string): boolean {
  const now = Date.now();
  const bucket = rateLimits.get(chatId);
  if (!bucket || now > bucket.resetAt) {
    rateLimits.set(chatId, { tokens: RATE_LIMIT_MAX - 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.tokens <= 0) return false;
  bucket.tokens--;
  return true;
}

const AVAILABLE_MODELS = ["deepseek-v4-flash", "kimi-k2.6", "deepseek-v4-pro", "mimo-v2.5-pro"];

const lookupAgent = Effect.fn("lookupAgent")(function* (chatId: string) {
  const { env } = yield* WorkersEnv;
  return yield* Effect.tryPromise(() => getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId));
});

interface CommandContext {
  postable: { post(message: string): Promise<unknown> };
  chatId: string;
  args: string;
}

interface CommandDef {
  name: string;
  description: string;
  slash: boolean;
  requiresStart?: boolean;
  handler: (ctx: CommandContext) => Effect.Effect<void, unknown, AppServices>;
}

export const commands: CommandDef[] = [
  {
    name: "start",
    description: "Start the bot",
    slash: true,
    requiresStart: true,
    handler: ({ postable }) =>
      Effect.tryPromise(() =>
        postable.post("Hello. I am Mizook. Send me a message and I will respond."),
      ),
  },
  {
    name: "reset",
    description: "Reset the conversation",
    slash: true,
    handler: ({ postable, chatId }) =>
      Effect.gen(function* () {
        const agent = yield* lookupAgent(chatId);
        yield* Effect.tryPromise(() => agent.resetChat());
        yield* Effect.tryPromise(() => postable.post("Chat reset. Starting fresh."));
        yield* Effect.logInfo(`reset_done chat_id=${chatId}`);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("reset_failed", cause);
            yield* Effect.tryPromise(() =>
              postable.post(
                `Reset failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
            ).pipe(Effect.catchCause(() => Effect.void));
          }),
        ),
      ),
  },
  {
    name: "help",
    description: "Show available commands",
    slash: true,
    handler: ({ postable }) =>
      Effect.tryPromise(() =>
        postable.post(
          "Available commands:\n" + commands.map((c) => `/${c.name} — ${c.description}`).join("\n"),
        ),
      ),
  },
  {
    name: "status",
    description: "Show bot status",
    slash: true,
    handler: ({ postable, chatId }) =>
      Effect.gen(function* () {
        const agent = yield* lookupAgent(chatId);
        const modelName = yield* Effect.tryPromise(() => agent.getModelName(chatId));
        const schedules = (yield* Effect.tryPromise(() => agent.listSchedules())) as Array<{
          callback: string;
        }>;
        const reminderCount = schedules.filter((s) => s.callback === "sendReminder").length;
        yield* Effect.tryPromise(() =>
          postable.post(`Model: ${modelName}\nActive reminders: ${reminderCount}`),
        );
      }),
  },
  {
    name: "model",
    description: "Show or set the current model",
    slash: true,
    handler: ({ postable, chatId, args }) =>
      Effect.gen(function* () {
        const agent = yield* lookupAgent(chatId);
        if (!args) {
          const current = yield* Effect.tryPromise(() => agent.getModelName(chatId));
          yield* Effect.tryPromise(() =>
            postable.post(`Current model: ${current}\nAvailable: ${AVAILABLE_MODELS.join(", ")}`),
          );
        } else if (!AVAILABLE_MODELS.includes(args)) {
          yield* Effect.tryPromise(() =>
            postable.post(`Unknown model "${args}". Available: ${AVAILABLE_MODELS.join(", ")}`),
          );
        } else {
          yield* Effect.tryPromise(() => agent.setModel(chatId, args));
          yield* Effect.tryPromise(() => postable.post(`Model set to ${args}`));
        }
      }),
  },
];

function findCommandByName(command: string): CommandDef | undefined {
  const name = command.startsWith("/") ? command.slice(1) : command;
  return commands.find((c) => c.name === name);
}

export function createBot(runtime: AppRuntime, env: Env, channel: Channel): Chat {
  const state = createCloudflareState({ namespace: env.CHAT_STATE });
  const chat = new Chat({
    userName: "mizook",
    adapters: {
      telegram: channel.adapter,
    },
    state,
    dedupeTtlMs: 600_000,
  });

  const allowedUsers = parseAllowedIds(env.TELEGRAM_ALLOWED_USER_IDS);

  const dispatchMessage = Effect.fn("dispatchMessage")(function* (
    mode: TurnMode,
    thread: Thread,
    message: Message,
  ) {
    if (mode.checkAccess && !allowedUsers.has(Number(message.author.userId))) {
      yield* Effect.tryPromise(() => thread.post("Access denied."));
      return;
    }
    yield* Effect.tryPromise(() => thread.subscribe());
    const { chatId } = channel.decodeThreadId(thread.id);
    if (!checkRateLimit(chatId)) {
      yield* Effect.tryPromise(() =>
        thread.post("Rate limit exceeded. Please wait a moment and try again."),
      );
      return;
    }
    yield* handleTurn(thread, message);
  });

  const dispatchSlash = (event: SlashCommandEvent) =>
    Effect.gen(function* () {
      if (!allowedUsers.has(Number(event.user.userId))) {
        yield* Effect.tryPromise(() => event.channel.post("Access denied."));
        return;
      }
      const cmd = findCommandByName(event.command);
      if (cmd) {
        const { chatId } = channel.decodeThreadId(event.channel.id);
        yield* cmd.handler({
          postable: event.channel,
          chatId,
          args: event.text,
        });
      }
    }).pipe(Effect.catchCause((cause) => Effect.logError("slash_error", cause)));

  const handleTurn = (thread: Thread, message: Message) =>
    Effect.gen(function* () {
      const traceId = crypto.randomUUID();
      yield* Effect.logInfo(`handleTurn_start trace_id=${traceId}`);
      const { chatId } = channel.decodeThreadId(thread.id);
      yield* Effect.logInfo(`handleTurn_resolved_channel chat_id=${chatId} trace_id=${traceId}`);
      const agent = yield* lookupAgent(chatId);
      yield* Effect.logInfo(`handleTurn_got_agent trace_id=${traceId}`);
      yield* Effect.tryPromise({
        try: () =>
          agent.submitTurn({
            thread: thread.toJSON(),
            chatId,
            threadId: thread.id,
            messageId: message.id,
            text: message.text,
            channelType: "telegram",
            traceId,
          }),
        catch: (cause) => new AgentRpcError({ cause }),
      });
      yield* Effect.logInfo(
        `turn_submitted chat_id=${chatId} thread_id=${thread.id} trace_id=${traceId}`,
      );
    }).pipe(Effect.catchCause((cause) => Effect.logError("turn_error", cause)));

  const onMessage = (mode: TurnMode, handlerName: string) => {
    return (t: Thread, m: Message) => {
      const eff = Effect.gen(function* () {
        if (handlerName === "dm") {
          yield* Effect.logInfo(`direct_message_received text=${m.text.slice(0, 50)}`);
        }
        yield* dispatchMessage(mode, t, m);
      }).pipe(
        Effect.annotateLogs({ thread_id: t.id, user_id: m.author.userId, handler: handlerName }),
      );
      void runtime.runPromise(
        eff.pipe(Effect.catchCause((cause) => Effect.logError("run_failed", cause))),
      );
    };
  };

  chat.onDirectMessage(onMessage({ checkAccess: true, handleStart: true }, "dm"));
  chat.onNewMention(onMessage({ checkAccess: true, handleStart: false }, "mention"));
  chat.onSubscribedMessage(onMessage({ checkAccess: false, handleStart: false }, "subscribed"));

  const slashNames = commands.filter((c) => c.slash).map((c) => c.name);
  chat.onSlashCommand(slashNames, (event) => {
    const eff = Effect.gen(function* () {
      yield* Effect.logInfo(`slash_command_received command=${event.command}`);
      yield* dispatchSlash(event);
    }).pipe(Effect.annotateLogs({ command: event.command, user_id: event.user.userId }));
    void runtime.runPromise(
      eff.pipe(Effect.catchCause((cause) => Effect.logError("run_failed", cause))),
    );
  });

  return chat;
}

interface TurnMode {
  readonly checkAccess: boolean;
  readonly handleStart: boolean;
}
