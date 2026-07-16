import { callable } from "agents";
import { Effect, Clock, Random } from "effect";
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
  SessionManager,
} from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import type { SerializedThread } from "chat";
import { ThreadImpl } from "chat";
import type { ToolSet } from "ai";

import type { Env } from "./env";
import { getRuntime, type AppServices } from "./runtime";
import { Model, createModel } from "./model";
import { ChannelRegistry } from "./channel-registry";
import { basePrompt } from "./prompts/base";
import { remindersPrompt } from "../features/reminders/prompts/reminders";
import { browserPrompt } from "../features/browser/prompts/browser";
import { createReminderTools, type ReminderPayload } from "../features/reminders/tools";
import { createBrowserTools } from "../features/browser/tools";
import { createArtifactTools } from "../features/artifacts/tools";
import { artifactsPrompt } from "../features/artifacts/prompts/artifacts";
// Per-chat model overrides. Resets on cold start — acceptable for a personal bot.
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

  private get runtime() {
    return getRuntime(this.env);
  }

  /** Bridge for tool `execute` bodies (Promise-shaped for the AI SDK) to run
   *  Effect-typed logic against the shared runtime. */
  run<A, E, R extends AppServices>(eff: Effect.Effect<A, E, R>): Promise<A> {
    return this.runtime.runPromise(eff);
  }

  /** Worker bindings (BROWSER/SCREENSHOTS/…) for tool `execute` bodies. */
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
    const chatId = this.currentTurn?.chatId;
    const override = chatId ? modelOverrides.get(chatId) : undefined;
    if (override) {
      return this.runtime.runSync(Effect.sync(() => createModel(this.env, override)));
    }
    return this.runtime.runSync(Model.use((m) => Effect.sync(() => m.chatModel)));
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
    return [
      basePrompt,
      remindersPrompt.replace("{{TIMEZONE}}", tz),
      browserPrompt,
      artifactsPrompt,
    ].join("\n\n");
  }

  configureSession(session: Session) {
    // Configure the base session with shared context blocks.
    // Per-topic sessions will be created via SessionManager.
    return session
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
      .onCompaction(
        createCompactFunction({
          summarize: (prompt: string) =>
            this.runtime.runPromise(Model.use((m) => m.summarize(prompt))),
        }),
      )
      .compactAfter(40_000)
      .withCachedPrompt();
  }

  private getOrCreateSessionManager(): SessionManager {
    if (!this.sessionManager) {
      this.sessionManager = SessionManager.create(this)
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
        .onCompaction(
          createCompactFunction({
            summarize: (prompt: string) =>
              this.runtime.runPromise(Model.use((m) => m.summarize(prompt))),
          }),
        )
        .compactAfter(40_000)
        .withCachedPrompt();
    }
    return this.sessionManager;
  }

  getTools(): ToolSet {
    return {
      ...createReminderTools(this),
      ...createBrowserTools(this),
      ...createArtifactTools(this),
    };
  }

  sendReminder(payload: ReminderPayload) {
    return this.runtime.runPromise(
      ChannelRegistry.use((r) =>
        r
          .get(payload.target.platform)
          .pipe(
            Effect.flatMap((ch) =>
              ch.postNotification(payload.target, `\u23f0 Reminder: ${payload.message}`),
            ),
          ),
      ),
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
        const manager = this.getOrCreateSessionManager();
        this.session = manager.getSession(input.threadId);

        // Append directly to the new session to avoid stale cache issues
        const id = yield* Random.nextUUIDv4;
        const createdAt = new Date(yield* Clock.currentTimeMillis);
        yield* Effect.tryPromise(() =>
          this.session.appendMessage({
            id,
            role: "user",
            parts: [{ type: "text", text: input.text }],
            createdAt,
          }),
        );
        yield* Effect.logInfo(
          `turn_received chat_id=${input.chatId} thread_id=${input.threadId} channel=${input.channelType}`,
        );
      }),
    );
  }

  override beforeTurn(_ctx: TurnContext) {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        const freshSystem = yield* Effect.tryPromise(() => this.session.refreshSystemPrompt());
        const turn = this.currentTurn;
        if (!turn || !this.serializedThread) return { system: freshSystem };

        const { channel } = yield* ChannelRegistry.use((r) => r.resolve(turn.threadId));
        const { readable, writable } = new TransformStream<string, string>();
        this.writer = writable.getWriter();
        const thread = ThreadImpl.fromJSON(this.serializedThread, channel.adapter);
        yield* Effect.tryPromise(() => thread.startTyping());
        this.pendingStream = thread.post(readable).catch((err) => {
          void this.runtime.runPromise(Effect.logError("stream_failed", err));
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
      void this.runtime.runPromise(
        Effect.logError("tool_failed", { toolName: ctx.toolName, error: msg }),
      );
    }

    const status = this.getToolSuccessMessage(ctx.toolName, ctx.output);

    if (status) {
      void this.runtime.runPromise(
        ChannelRegistry.use((r) =>
          r
            .get(turn.channelType)
            .pipe(
              Effect.flatMap((ch) =>
                ch.postNotification({ platform: turn.channelType, chatId: turn.chatId }, status),
              ),
            ),
        ),
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
      case "write_artifact":
        return "📄 Artifact saved";
      case "list_artifacts":
        return null;
      case "delete_artifact":
        return "🗑️ Artifact deleted";
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
      this.writer = null;
      this.pendingStream = null;
    }).pipe(Effect.catchCause((cause) => Effect.logError("stream_cleanup_failed", cause)));
  }

  override onChatResponse(result: ChatResponseResult) {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* this.cleanupStream();
        const turn = this.currentTurn;
        const latency = turn ? (yield* Clock.currentTimeMillis) - turn.startTime : 0;
        this.currentTurn = null;
        this.serializedThread = null;
        yield* Effect.logInfo(
          `turn_complete request_id=${result.requestId} model=${this.env.OPENCODE_GO_MODEL ?? ""} latency_ms=${latency} status=${result.status} channel=${turn?.channelType ?? "?"} trace_id=${turn?.traceId ?? "?"}`,
        );
      }),
    );
  }

  override onChatError(error: unknown) {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* this.cleanupStream();
        const turn = this.currentTurn;
        const serialized = this.serializedThread;
        this.currentTurn = null;
        this.serializedThread = null;
        if (turn && serialized) {
          const { channel } = yield* ChannelRegistry.use((r) => r.resolve(turn.threadId));
          const thread = ThreadImpl.fromJSON(serialized, channel.adapter);
          yield* Effect.tryPromise(() => thread.post("Sorry, something went wrong."));
        }
        yield* Effect.logError("turn_error", error);
        return error;
      }),
    );
  }
}
