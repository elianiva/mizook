import { callable } from "agents";
import { Effect, Clock } from "effect";
import {
  Think,
  type ChunkContext,
  type ChatResponseResult,
  type Session,
  type TurnContext,
  type ToolCallResultContext,
} from "@cloudflare/think";
import {
  AgentContextProvider,
  AgentSearchProvider,
  Session as AgentSession,
  SessionManager,
} from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import type { SerializedThread } from "chat";
import { ThreadImpl } from "chat";
import type { ToolSet } from "ai";

import type { Env } from "./env";
import { getRuntime, type AppServices } from "./runtime";
import { createModel, summarize } from "./model";
import { createTelegramChannel } from "../features/telegram/channel";
import type { Channel } from "./channel";
import { basePrompt } from "./prompts/base";
import { remindersPrompt } from "../features/reminders/prompts/reminders";
import { browserPrompt } from "../features/browser/prompts/browser";
import { createReminderTools, type ReminderPayload } from "../features/reminders/tools";
import { createBrowserTools } from "../features/browser/tools";

const modelOverrides = new Map<string, string>();

interface TurnState {
  readonly channelType: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly replyToMessageId: number;
  readonly startTime: number;
  readonly traceId: string;
}

export class MizookAgent extends Think<Env> {
  // Framework-driven mutable turn state. Think's lifecycle is a sequence of
  // independent callbacks (submitTurn → beforeTurn → onChunk* → onChat*),
  // so the turn context must persist on the instance between them. Kept to the
  // minimum the streaming wiring needs.
  private currentTurn: TurnState | null = null;
  private serializedThread: SerializedThread | null = null;
  private writer: WritableStreamDefaultWriter<string> | null = null;
  private pendingStream: Promise<unknown> | null = null;
  private sessionManager: SessionManager | null = null;

  waitForMcpConnections = { timeout: 10_000 } as const;

  private _channel: Channel | null = null;

  get channel(): Channel {
    if (!this._channel) {
      this._channel = createTelegramChannel(this.env.BOT_TOKEN);
    }
    return this._channel;
  }

  private get runtime() {
    return getRuntime(this.env);
  }

  run<A, E, R extends AppServices>(eff: Effect.Effect<A, E, R>): Promise<A> {
    return this.runtime.runPromise(eff);
  }

  get appEnv() {
    return this.env;
  }

  getTurnState(): TurnState | null {
    return this.currentTurn;
  }

  getConfiguredTimezone(): string {
    return this.env.TIMEZONE ?? "Asia/Jakarta";
  }

  getModel() {
    return createModel(this.env, this.getModelName(this.currentTurn?.chatId));
  }

  @callable()
  getModelName(chatId?: string): string {
    const id = chatId ?? this.currentTurn?.chatId;
    const override = id ? modelOverrides.get(id) : undefined;
    return override ?? this.env.OPENCODE_GO_MODEL ?? "mimo-v2.5";
  }

  @callable()
  setModel(chatId: string, modelName: string) {
    modelOverrides.set(chatId, modelName);
  }

  getSystemPrompt() {
    const tz = this.getConfiguredTimezone();
    return [basePrompt, remindersPrompt.replace("{{TIMEZONE}}", tz), browserPrompt].join("\n\n");
  }

  private _applySessionConfig<T extends AgentSession | SessionManager>(builder: T): T {
    const summarizer = (prompt: string) => summarize(this.env, prompt);

    return builder
      .withContext("soul", {
        description:
          "Your identity, personality, and core instructions. " +
          "Write to this with set_context to change who you are.",
        maxTokens: 1000,
      })
      .withContext("memory", {
        description:
          "Key facts, preferences, and context learned from the user. " +
          "Proactively update this as you learn new information.",
        maxTokens: 2000,
      })
      .withContext("history", {
        provider: new AgentSearchProvider(this),
        description: "Full-text search across your conversation history with this assistant.",
      })
      .onCompaction(createCompactFunction({ summarize: summarizer }))
      .compactAfter(40_000)
      .withCachedPrompt() as T;
  }

  configureSession(session: Session) {
    return this._applySessionConfig(session);
  }

  private getOrCreateSessionManager(): SessionManager {
    if (!this.sessionManager) {
      this.sessionManager = this._applySessionConfig(SessionManager.create(this));
    }
    return this.sessionManager;
  }

  getTools(): ToolSet {
    return {
      ...createReminderTools(this),
      ...createBrowserTools(this),
    };
  }

  sendReminder(payload: ReminderPayload) {
    return this.runtime.runPromise(
      this.channel.postNotification(payload.target, `\u23f0 Reminder: ${payload.message}`),
    );
  }

  override onStart(): Promise<void> {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        const provider = new AgentContextProvider(this, "soul");
        const stored = yield* Effect.tryPromise(() => provider.get());
        if (!stored) {
          yield* Effect.tryPromise(() => provider.set(this.getSystemPrompt()));
        }
        if (this.env.EXA_API_KEY) {
          const exaKey = this.env.EXA_API_KEY;
          yield* Effect.tryPromise(() =>
            this.addMcpServer("exa", "https://mcp.exa.ai/mcp", {
              transport: { headers: { "x-api-key": exaKey } },
            }),
          );
        }
        if (this.env.CF_API_TOKEN) {
          yield* Effect.tryPromise(() =>
            this.addMcpServer("cloudflare", "https://mcp.cloudflare.com/mcp", {
              transport: { headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` } },
            }),
          );
        }
        yield* Effect.logInfo("agent_onStart_done");
      }),
    );
  }

  @callable()
  resetChat() {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        const threadId = this.currentTurn?.threadId;
        this.resetTurnState();
        this.currentTurn = null;

        // Clear only the current topic's session
        if (threadId && this.sessionManager) {
          const topicSession = this.sessionManager.getSession(threadId);
          yield* Effect.tryPromise(() => topicSession.clearMessages());
        } else {
          yield* Effect.tryPromise(() => this.clearMessages());
        }

        yield* Effect.tryPromise(() => this.session.refreshSystemPrompt());
        yield* Effect.logInfo(`reset_chat_done thread_id=${threadId ?? "all"}`);
      }),
    );
  }

  @callable()
  submitTurn(input: {
    thread: SerializedThread;
    chatId: string;
    threadId: string;
    messageId: string;
    text: string;
    channelType: string;
    traceId: string;
  }) {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* Effect.logInfo(
          `submitTurn_called chat_id=${input.chatId} thread_id=${input.threadId}`,
        );

        const now = yield* Clock.currentTimeMillis;
        const manager = this.getOrCreateSessionManager();
        this.serializedThread = input.thread;
        this.currentTurn = {
          channelType: input.channelType,
          chatId: input.chatId,
          threadId: input.threadId,
          replyToMessageId: Number(input.messageId),
          startTime: now,
          traceId: input.traceId,
        };

        // Switch to per-topic session for conversation isolation
        this.session = manager.getSession(input.threadId);

        // Persist turn state so beforeTurn/onChatError can recover it
        // after eviction. The serialized thread and chat target live here
        // so the response can still be delivered even if the DO cold-starts.
        yield* Effect.tryPromise(() =>
          this.ctx.storage.put({
            __turn: this.currentTurn,
            __serializedThread: this.serializedThread,
          }),
        );

        yield* Effect.logInfo(
          `turn_received chat_id=${input.chatId} thread_id=${input.threadId} channel=${input.channelType}`,
        );

        this.runTurn({ mode: "submit", input: input.text }).catch((err) =>
          Effect.logError("runTurn_failed", err),
        );
      }),
    );
  }

  override beforeTurn(_ctx: TurnContext) {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* Effect.logInfo(`beforeTurn_start session_id=${this.session ? "set" : "null"}`);
        const freshSystem = yield* Effect.tryPromise(() => this.session.refreshSystemPrompt());
        let turn = this.currentTurn;
        let serialized = this.serializedThread;

        // Recover from DO storage if cold-started after eviction
        if (!turn || !serialized) {
          const stored = yield* Effect.tryPromise(() =>
            this.ctx.storage.get<unknown>(["__turn", "__serializedThread"]),
          ).pipe(Effect.catchCause(() => Effect.succeed(new Map())));
          if (stored instanceof Map) {
            const st = stored as Map<string, unknown>;
            const recoveredTurn = st.get("__turn") as TurnState | undefined;
            const recoveredSerialized = st.get("__serializedThread") as
              | SerializedThread
              | undefined;
            if (recoveredTurn && recoveredSerialized) {
              yield* Effect.sync(() => {
                this.currentTurn = recoveredTurn;
                this.serializedThread = recoveredSerialized;
              });
              yield* Effect.logInfo(
                `beforeTurn_recovered_from_storage thread_id=${recoveredTurn.threadId}`,
              );
              turn = recoveredTurn;
              serialized = recoveredSerialized;
            }
          }
        }

        if (!turn || !serialized) {
          yield* Effect.logInfo(
            `beforeTurn_no_turn_context turn=${!!turn} serialized=${!!serialized}`,
          );
          return { system: freshSystem };
        }

        const { readable, writable } = new TransformStream<string, string>();
        const thread = ThreadImpl.fromJSON(serialized, this.channel.adapter);
        yield* Effect.tryPromise(() => thread.startTyping());
        yield* Effect.sync(() => {
          this.writer = writable.getWriter();
          this.pendingStream = thread
            .post(readable)
            .catch((err) => this.runtime.runFork(Effect.logError("stream_failed", err)));
        });
        return { system: freshSystem };
      }),
    );
  }

  override onChunk({ chunk }: ChunkContext) {
    if (chunk.type !== "text-delta" || !chunk.text) return;
    void this.writer?.write(chunk.text);
  }

  override afterToolCall(ctx: ToolCallResultContext) {
    const turn = this.currentTurn;
    if (!turn) return;

    if (!ctx.success) {
      const msg = ctx.error instanceof Error ? ctx.error.message : String(ctx.error);
      this.runtime.runFork(Effect.logError("tool_failed", { toolName: ctx.toolName, error: msg }));
    }

    const status = this.getToolSuccessMessage(ctx.toolName, ctx.output);

    if (status) {
      this.runtime.runFork(
        this.channel.postNotification({ platform: turn.channelType, chatId: turn.chatId }, status),
      );
    }
  }

  private getToolSuccessMessage(toolName: string, output: unknown): string | null {
    const result = typeof output === "string" ? output : JSON.stringify(output);
    switch (toolName) {
      case "browser_screenshot_and_send":
        return "📸 Screenshot sent";
      case "set_reminder":
        return result?.includes("Recurring") ? "🔁 Recurring reminder set" : "⏰ Reminder set";
      case "list_reminders":
        return null;
      case "delete_reminder":
        return "🗑️ Reminder deleted";
      case "delete_all_reminders":
        return "🗑️ Reminders cleared";

      default:
        return null;
    }
  }

  private cleanupStream() {
    return Effect.gen({ self: this }, function* () {
      const writer = this.writer;
      const pending = this.pendingStream;
      if (writer) yield* Effect.tryPromise(() => writer.close());
      if (pending) yield* Effect.tryPromise(() => pending);
      yield* Effect.sync(() => {
        this.writer = null;
        this.pendingStream = null;
      });
    }).pipe(Effect.catchCause((cause) => Effect.logError("stream_cleanup_failed", cause)));
  }

  override onChatResponse(result: ChatResponseResult) {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* Effect.logInfo(`onChatResponse_start status=${result.status}`);
        yield* this.cleanupStream();
        // Clear both memory and storage so a stale __turn never poisons a subsequent turn
        yield* Effect.sync(() => {
          this.currentTurn = null;
          this.serializedThread = null;
        });
        yield* Effect.tryPromise(() =>
          this.ctx.storage.delete(["__turn", "__serializedThread"]),
        ).pipe(Effect.catchCause(() => Effect.void));
        yield* Effect.logInfo(
          `turn_complete request_id=${result.requestId} model=${this.env.OPENCODE_GO_MODEL ?? ""}`,
        );
      }),
    );
  }

  override onChatError(error: unknown) {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* this.cleanupStream();
        let turn = this.currentTurn;
        let serialized = this.serializedThread;

        // Recover from DO storage if cold-started
        if (!turn || !serialized) {
          const stored = yield* Effect.tryPromise(() =>
            this.ctx.storage.get<unknown>(["__turn", "__serializedThread"]),
          ).pipe(Effect.catchCause(() => Effect.succeed(new Map())));
          if (stored instanceof Map) {
            const st = stored as Map<string, unknown>;
            const recoveredTurn = st.get("__turn") as TurnState | undefined;
            const recoveredSerialized = st.get("__serializedThread") as
              | SerializedThread
              | undefined;
            if (recoveredTurn && recoveredSerialized) {
              turn = recoveredTurn;
              serialized = recoveredSerialized;
            }
          }
        }

        yield* Effect.sync(() => {
          this.currentTurn = null;
          this.serializedThread = null;
        });
        yield* Effect.tryPromise(() =>
          this.ctx.storage.delete(["__turn", "__serializedThread"]),
        ).pipe(Effect.catchCause(() => Effect.void));

        if (turn && serialized) {
          const thread = ThreadImpl.fromJSON(serialized, this.channel.adapter);
          yield* Effect.tryPromise(() => thread.post("Sorry, something went wrong."));
        }
        yield* Effect.logError("turn_error", error);
        return error;
      }),
    );
  }
}
