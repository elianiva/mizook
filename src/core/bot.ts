import { Effect } from "effect";
import { Chat } from "chat";
import type { Thread, Message, SlashCommandEvent, Adapter } from "chat";
import { createCloudflareState } from "chat-state-cloudflare-do";
import type { Env } from "./env";
import type { AppRuntime, AppServices } from "./runtime";
import { ChannelRegistry } from "./channel-registry";
import { AgentGateway } from "./agent-gateway";
import { AllowedUsers } from "./allowed-users";
import { AgentRpcError } from "./errors";

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

// ── Command registry ────────────────────────────────────────────────────
// Every bot command lives here. `slash: true` registers it with Telegram's
// command menu AND the text-message path. Both entry points call the same
// handler with the same context.

interface CommandContext {
  postable: { post(message: string): Promise<unknown> };
  threadId: string;
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
    handler: ({ postable, threadId }) =>
      Effect.gen(function* () {
        const { channelName, chatId } = yield* ChannelRegistry.use((r) => r.resolve(threadId));
        const agent = yield* AgentGateway.use((g) => g.lookup(chatId));
        yield* Effect.tryPromise(() => agent.resetChat());
        yield* Effect.tryPromise(() => postable.post("Chat reset. Starting fresh."));
        yield* Effect.logInfo(`reset_done chat_id=${chatId} channel=${channelName}`);
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
    handler: ({ postable, threadId }) =>
      Effect.gen(function* () {
        const { chatId } = yield* ChannelRegistry.use((r) => r.resolve(threadId));
        const agent = yield* AgentGateway.use((g) => g.lookup(chatId));
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
    handler: ({ postable, threadId, args }) =>
      Effect.gen(function* () {
        const { chatId } = yield* ChannelRegistry.use((r) => r.resolve(threadId));
        const agent = yield* AgentGateway.use((g) => g.lookup(chatId));
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

function findCommand(text: string): { command: CommandDef; args: string } | undefined {
  const trimmed = text.trim();
  for (const cmd of commands) {
    if (trimmed === `/${cmd.name}`) return { command: cmd, args: "" };
    if (trimmed.startsWith(`/${cmd.name} `))
      return { command: cmd, args: trimmed.slice(cmd.name.length + 2).trim() };
  }
  return undefined;
}

// ── Dispatch ────────────────────────────────────────────────────────────

interface TurnMode {
  readonly checkAccess: boolean;
  readonly handleStart: boolean;
}

const dispatchMessage = (mode: TurnMode) => (thread: Thread, message: Message) =>
  Effect.gen(function* () {
    if (mode.checkAccess) {
      const ok = yield* AllowedUsers.use((a) =>
        Effect.sync(() => a.has(Number(message.author.userId))),
      );
      if (!ok) {
        yield* Effect.tryPromise(() => thread.post("Access denied."));
        return;
      }
    }
    yield* Effect.tryPromise(() => thread.subscribe());

    const match = findCommand(message.text);
    if (match) {
      const { command, args } = match;
      if (command.requiresStart && !mode.handleStart) return;
      yield* command.handler({ postable: thread, threadId: thread.id, args });
      return;
    }

    const { chatId } = yield* ChannelRegistry.use((r) => r.resolve(thread.id));
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
    const ok = yield* AllowedUsers.use((a) => Effect.sync(() => a.has(Number(event.user.userId))));
    if (!ok) {
      yield* Effect.tryPromise(() => event.channel.post("Access denied."));
      return;
    }
    const match = findCommand(event.command);
    if (match) {
      yield* match.command.handler({
        postable: event.channel,
        threadId: event.channel.id,
        args: event.text,
      });
    }
  }).pipe(Effect.catchCause((cause) => Effect.logError("slash_error", cause)));

const handleTurn = (thread: Thread, message: Message) =>
  Effect.gen(function* () {
    const traceId = crypto.randomUUID();
    yield* Effect.logInfo(`handleTurn_start trace_id=${traceId}`);
    const { channelName, chatId } = yield* ChannelRegistry.use((r) => r.resolve(thread.id));
    yield* Effect.logInfo(`handleTurn_resolved_channel chat_id=${chatId} trace_id=${traceId}`);
    const agent = yield* AgentGateway.use((g) => g.lookup(chatId));
    yield* Effect.logInfo(`handleTurn_got_agent trace_id=${traceId}`);
    yield* Effect.tryPromise({
      try: () =>
        agent.submitTurn({
          thread: thread.toJSON(),
          chatId,
          threadId: thread.id,
          messageId: message.id,
          text: message.text,
          channelType: channelName,
          traceId,
        }),
      catch: (cause) => new AgentRpcError({ cause }),
    });
    yield* Effect.logInfo(
      `turn_submitted chat_id=${chatId} thread_id=${thread.id} channel=${channelName} trace_id=${traceId}`,
    );
  }).pipe(Effect.catchCause((cause) => Effect.logError("turn_error", cause)));

// ── Bot wiring ──────────────────────────────────────────────────────────

export function createBot(runtime: AppRuntime, env: Env): Chat {
  const adapters = runtime.runSync(
    ChannelRegistry.use((r) => Effect.sync(() => r.adapters)),
  ) as Record<string, Adapter>;
  const state = createCloudflareState({ namespace: env.CHAT_STATE });
  const chat = new Chat({ userName: "mizook", adapters, state, dedupeTtlMs: 600_000 });

  const onMessage = (mode: TurnMode, handlerName: string) => {
    return (t: Thread, m: Message) => {
      const eff = Effect.gen(function* () {
        if (handlerName === "dm") {
          yield* Effect.logInfo(`direct_message_received text=${m.text.slice(0, 50)}`);
        }
        yield* dispatchMessage(mode)(t, m);
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
