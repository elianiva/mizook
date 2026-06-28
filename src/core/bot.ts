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

interface Postable {
  post(message: string): Promise<unknown>;
}

// Chat reset shared by the message-path "/reset" command and the slash-command
// "/reset". Splits the postable (thread or slash channel) from routing so both
// entry points reuse one effect.
const resetCore = (postable: Postable, threadId: string) =>
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
          postable.post(`Reset failed: ${cause instanceof Error ? cause.message : String(cause)}`),
        ).pipe(Effect.catchCause(() => Effect.void));
      }),
    ),
  );

const handleTurn = (thread: Thread, message: Message) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("handleTurn_start");
    const { channelName, chatId } = yield* ChannelRegistry.use((r) => r.resolve(thread.id));
    yield* Effect.logInfo(`handleTurn_resolved_channel chat_id=${chatId}`);
    const agent = yield* AgentGateway.use((g) => g.lookup(chatId));
    yield* Effect.logInfo("handleTurn_got_agent");
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
    yield* Effect.logInfo(`turn_submitted chat_id=${chatId} channel=${channelName}`);
  }).pipe(Effect.catchCause((cause) => Effect.logError("turn_error", cause)));

interface TurnMode {
  readonly checkAccess: boolean;
  readonly handleStart: boolean;
}

const dispatchMessage = (mode: TurnMode) => (thread: Thread, message: Message) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("dispatchMessage_start");
    if (mode.checkAccess) {
      const ok = yield* AllowedUsers.use((a) =>
        Effect.sync(() => a.has(Number(message.author.userId))),
      );
      if (!ok) {
        yield* Effect.tryPromise(() => thread.post("Access denied."));
        yield* Effect.logInfo("access_denied");
        return;
      }
    }
    yield* Effect.tryPromise(() => thread.subscribe());
    yield* Effect.logInfo("dispatchMessage_subscribed");
    const text = message.text.trim();

    if (text === "/start" && mode.handleStart) {
      yield* Effect.tryPromise(() =>
        thread.post("Hello. I am Mizook. Send me a message and I will respond."),
      );
      yield* Effect.logInfo("command_start");
      return;
    }

    if (text === "/reset") {
      yield* resetCore(thread, thread.id);
      return;
    }

    yield* Effect.logInfo("dispatchMessage_about_to_handleTurn");
    yield* handleTurn(thread, message);
  });

const dispatchSlash = (event: SlashCommandEvent) =>
  Effect.gen(function* () {
    const ok = yield* AllowedUsers.use((a) => Effect.sync(() => a.has(Number(event.user.userId))));
    if (!ok) {
      yield* Effect.tryPromise(() => event.channel.post("Access denied."));
      yield* Effect.logInfo("slash_access_denied");
      return;
    }
    if (event.command === "/start") {
      yield* Effect.tryPromise(() =>
        event.channel.post("Hello. I am Mizook. Send me a message and I will respond."),
      );
      yield* Effect.logInfo("slash_start_done");
      return;
    }
    yield* resetCore(event.channel, event.channel.id);
    yield* Effect.logInfo("slash_reset_done");
  }).pipe(Effect.catchCause((cause) => Effect.logError("slash_error", cause)));

export function createBot(runtime: AppRuntime, env: Env): Chat {
  const adapters = runtime.runSync(
    ChannelRegistry.use((r) => Effect.sync(() => r.adapters)),
  ) as Record<string, Adapter>;
  const state = createCloudflareState({ namespace: env.CHAT_STATE });
  const chat = new Chat({ userName: "mizook", adapters, state, dedupeTtlMs: 600_000 });

  const handle = (eff: Effect.Effect<void, unknown, AppServices>, label?: string) => {
    const labeled = eff.pipe(Effect.annotateLogs({ label: label ?? "?" }));
    return runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo("handle_start");
        yield* labeled;
        yield* Effect.logInfo("handle_complete");
      }).pipe(Effect.catchCause((cause) => Effect.logError("handle_failed", cause))),
    );
  };
  const annotate =
    (values: Record<string, unknown>) =>
    <A, E, R>(eff: Effect.Effect<A, E, R>) =>
      Effect.annotateLogs(eff, values);

  chat.onDirectMessage((t, m) => {
    const eff = Effect.gen(function* () {
      yield* Effect.logInfo(`direct_message_received text=${m.text.slice(0, 50)}`);
      yield* dispatchMessage({ checkAccess: true, handleStart: true })(t, m);
    }).pipe(annotate({ thread_id: t.id, user_id: m.author.userId, handler: "dm" }));
    return handle(eff, `dm:${t.id}`);
  });
  chat.onNewMention((t, m) => {
    const eff = dispatchMessage({ checkAccess: true, handleStart: false })(t, m).pipe(
      annotate({ thread_id: t.id, user_id: m.author.userId, handler: "mention" }),
    );
    return handle(eff);
  });
  chat.onSubscribedMessage((t, m) => {
    const eff = dispatchMessage({ checkAccess: false, handleStart: false })(t, m).pipe(
      annotate({ thread_id: t.id, user_id: m.author.userId, handler: "subscribed" }),
    );
    return handle(eff);
  });
  chat.onSlashCommand(["start", "reset"], (event) => {
    const eff = Effect.gen(function* () {
      yield* Effect.logInfo(`slash_command_received command=${event.command}`);
      yield* dispatchSlash(event);
    }).pipe(annotate({ command: event.command, user_id: event.user.userId }));
    return handle(eff, `slash:${event.command}`);
  });

  return chat;
}
