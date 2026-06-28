import { callable } from "agents";
import { Effect, Clock, Random } from "effect";
import {
  Think,
  type ChunkContext,
  type ChatResponseResult,
  type Session,
  type TurnContext,
} from "@cloudflare/think";
import type { SerializedThread } from "chat";
import type { ToolSet } from "ai";
import { ThreadImpl } from "chat";
import { AgentContextProvider } from "agents/experimental/memory/session";
import type { Env } from "./env";
import { createScopedLogger } from "./logger";
import { createModel, DEFAULT_MODEL } from "./model";
import { configureSession } from "./session";
import type { ChannelInterface } from "./channel";

import { basePrompt } from "./prompts/base";
import { createReminderTools, type ReminderPayload } from "../features/reminders/tools";
import { createBrowserTools } from "../features/browser/tools";
import { createTelegramChannel } from "../features/telegram/channel";
import { remindersPrompt } from "../features/reminders/prompts/reminders";
import { browserPrompt } from "../features/browser/prompts/browser";

interface TurnState {
  channelType: string;
  chatId: string;
  replyToMessageId: number;
  startTime: number;
}

export class MizookAgent extends Think<Env> {
  private turnState: TurnState | null = null;
  private streamWriter: WritableStreamDefaultWriter<string> | null = null;
  private pendingStream: Promise<unknown> | null = null;
  private serializedThread: SerializedThread | null = null;
  private turnLog: ReturnType<typeof createScopedLogger> | null = null;
  private _channel: ChannelInterface | null = null;
  waitForMcpConnections = { timeout: 10_000 } as const;

  getTurnState(): TurnState | null {
    return this.turnState;
  }

  getConfiguredTimezone(): string {
    return this.env.TIMEZONE ?? "Asia/Jakarta";
  }

  // Currently always creates a Telegram channel — multi-channel will need
  // channel factory injection (e.g. via constructor or per-turn dispatch).
  private getChannel(): ChannelInterface {
    if (!this._channel) {
      this._channel = createTelegramChannel(this.env.BOT_TOKEN);
    }
    return this._channel;
  }

  getModel() {
    return createModel(this.env);
  }

  getSystemPrompt() {
    const tz = this.getConfiguredTimezone();
    return [basePrompt, remindersPrompt.replace("{{TIMEZONE}}", tz), browserPrompt].join("\n\n");
  }

  configureSession(session: Session) {
    return configureSession(session, this, this.env);
  }

  getTools(): ToolSet {
    const channel = this.getChannel();
    const getTarget = () => {
      const ts = this.turnState;
      return ts ? { platform: ts.channelType, chatId: ts.chatId } : null;
    };
    return {
      ...createReminderTools(this),
      ...createBrowserTools(this.env, channel, getTarget),
    };
  }

  sendReminder(payload: ReminderPayload) {
    const channel = this.getChannel();
    return Effect.gen(function* () {
      yield* channel.postNotification(payload.target, `\u23f0 Reminder: ${payload.message}`);
    }).pipe(Effect.runPromise);
  }

  onStart() {
    return Effect.gen({ self: this }, function* () {
      const provider = new AgentContextProvider(this, "soul");
      const stored = yield* Effect.tryPromise(() => provider.get());
      if (!stored) {
        yield* Effect.tryPromise(() => provider.set(this.getSystemPrompt()));
      }

      if (this.env.EXA_API_KEY) {
        yield* Effect.tryPromise(() =>
          this.addMcpServer("exa", `https://mcp.exa.ai/mcp?exaApiKey=${this.env.EXA_API_KEY}`),
        );
      }

      if (this.env.CF_API_TOKEN) {
        yield* Effect.tryPromise(() =>
          this.addMcpServer("cloudflare", "https://mcp.cloudflare.com/mcp", {
            transport: {
              headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` },
            },
          }),
        );
      }
    }).pipe(Effect.runPromise);
  }

  @callable()
  resetChat() {
    const log = createScopedLogger({ action: "reset_chat" });
    return Effect.gen({ self: this }, function* () {
      this.resetTurnState();
      yield* Effect.tryPromise(() => this.clearMessages());
      yield* Effect.tryPromise(() => this.session.refreshSystemPrompt());
    }).pipe(
      Effect.tap(() => Effect.sync(() => log.emit({ message: "reset_chat_done" }))),
      Effect.runPromise,
    );
  }

  @callable()
  submitTurn(input: {
    thread: SerializedThread;
    chatId: string;
    messageId: string;
    text: string;
    channelType: string;
  }) {
    return Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis;
      this.serializedThread = input.thread;
      this.turnState = {
        channelType: input.channelType,
        chatId: input.chatId,
        replyToMessageId: Number(input.messageId),
        startTime: now,
      };
      this._channel = null; // rebuild on next getChannel() in case channelType changes
      this.turnLog = createScopedLogger({
        action: "turn",
        chat_id: input.chatId,
        message_id: input.messageId,
        channel: input.channelType,
        phase: "submitted",
      });
      const id = yield* Random.nextUUIDv4;
      const createdAt = new Date(yield* Clock.currentTimeMillis);
      yield* Effect.tryPromise(() =>
        this.saveMessages((current) => [
          ...current,
          {
            id,
            role: "user",
            parts: [{ type: "text", text: input.text }],
            createdAt,
          },
        ]),
      );
    }).pipe(Effect.runPromise);
  }

  override beforeTurn(_ctx: TurnContext) {
    return Effect.gen({ self: this }, function* () {
      const freshSystem = yield* Effect.tryPromise(() => this.session.refreshSystemPrompt());
      const turn = this.turnState;
      if (!turn) return { system: freshSystem };
      if (this.turnLog) {
        this.turnLog.set({ detail: { phase: "before_turn" } });
      }
      if (!this.serializedThread) return { system: freshSystem };

      const channel = this.getChannel();
      const { readable, writable } = new TransformStream<string, string>();
      this.streamWriter = writable.getWriter();
      const thread = ThreadImpl.fromJSON(this.serializedThread, channel.adapter);
      yield* Effect.tryPromise(() => thread.startTyping());
      this.pendingStream = thread.post(readable).catch((err) => {
        Effect.logError("stream failed:", err);
      });
      return { system: freshSystem };
    }).pipe(Effect.runPromise);
  }

  override onChunk({ chunk }: ChunkContext) {
    if (chunk.type !== "text-delta" || !chunk.text) return;
    void this.streamWriter?.write(chunk.text);
  }

  private cleanupStream() {
    return Effect.gen({ self: this }, function* () {
      const writer = this.streamWriter;
      const pending = this.pendingStream;
      if (writer) yield* Effect.tryPromise(() => writer.close());
      if (pending) yield* Effect.tryPromise(() => pending);
      this.streamWriter = null;
      this.pendingStream = null;
    });
  }

  override onChatResponse(result: ChatResponseResult) {
    return Effect.gen({ self: this }, function* () {
      yield* this.cleanupStream();
      this.serializedThread = null;
      const turn = this.turnState;
      this.turnState = null;
      if (this.turnLog) {
        const now = yield* Clock.currentTimeMillis;
        this.turnLog.set({
          detail: {
            phase: "complete",
            requestId: result.requestId,
            model: this.env.OPENCODE_GO_MODEL ?? DEFAULT_MODEL,
            latencyMs: turn ? now - turn.startTime : 0,
            result: result.status,
            channel: turn?.channelType,
          },
        });
        this.turnLog.emit({ message: "turn_complete" });
        this.turnLog = null;
      }
    }).pipe(Effect.runPromise);
  }

  override onChatError(error: unknown) {
    return Effect.gen({ self: this }, function* () {
      yield* this.cleanupStream();
      const turn = this.turnState;
      this.turnState = null;
      if (turn && this.serializedThread) {
        const channel = this.getChannel();
        const thread = ThreadImpl.fromJSON(this.serializedThread, channel.adapter);
        yield* Effect.tryPromise(() => thread.post("Sorry, something went wrong."));
      }
      this.serializedThread = null;
      if (this.turnLog) {
        this.turnLog.set({
          detail: {
            phase: "error",
            error: error instanceof Error ? error.message : String(error),
            channel: turn?.channelType,
          },
        });
        if (error instanceof Error) this.turnLog.error(error);
        this.turnLog.emit({ message: "turn_error" });
        this.turnLog = null;
      }
      return error;
    }).pipe(Effect.runPromise);
  }
}
