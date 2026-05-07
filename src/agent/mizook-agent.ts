import { callable } from "agents";
import { Effect, Clock, Option } from "effect";
import {
  Think,
  type ChunkContext,
  type ChatResponseResult,
  type Session,
  type TurnContext,
} from "@cloudflare/think";
import type { ToolSet } from "ai";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { TelegramAdapter } from "@chat-adapter/telegram";
import { createDiscordAdapter } from "@chat-adapter/discord";
import type { DiscordAdapter } from "@chat-adapter/discord";
import { AgentContextProvider } from "agents/experimental/memory/session";
import { ThreadImpl, type SerializedThread } from "chat";
import type { Env } from "../env";
import { createScopedLogger } from "../logger";
import { createModel } from "./model";
import { configureSession } from "./session";
import { createReminderTools } from "../tools/reminders";

type ReminderPayload = {
  chatId: number;
  message: string;
};

export type TurnState =
  | {
      platform: "telegram";
      chatId: number;
      replyToMessageId?: number;
      startTime: number;
    }
  | {
      platform: "discord";
      threadId: string;
      replyToMessageId?: string;
      startTime: number;
    };

export class MizookAgent extends Think<Env> {
  private _turnState: Option.Option<TurnState> = Option.none();
  private streamWriter: Option.Option<WritableStreamDefaultWriter<string>> = Option.none();
  private pendingStream: Option.Option<Promise<unknown>> = Option.none();
  private serializedThread: Option.Option<SerializedThread> = Option.none();
  private turnLog: Option.Option<ReturnType<typeof createScopedLogger>> = Option.none();
  private _telegram: Option.Option<TelegramAdapter> = Option.none();
  private _discord: Option.Option<DiscordAdapter> = Option.none();

  waitForMcpConnections = { timeout: 10_000 } as const;

  getTurnState(): Option.Option<TurnState> {
    return this._turnState;
  }

  private getTelegram(): TelegramAdapter {
    return Option.getOrElse(this._telegram, () => {
      const adapter = createTelegramAdapter({ botToken: this.env.BOT_TOKEN });
      this._telegram = Option.some(adapter);
      return adapter;
    });
  }

  private getDiscord(): DiscordAdapter {
    return Option.getOrElse(this._discord, () => {
      const adapter = createDiscordAdapter({
        botToken: this.env.DISCORD_BOT_TOKEN,
        publicKey: this.env.DISCORD_PUBLIC_KEY,
        applicationId: this.env.DISCORD_APPLICATION_ID,
      });
      this._discord = Option.some(adapter);
      return adapter;
    });
  }

  private telegramThreadId(chatId: number): string {
    return this.getTelegram().encodeThreadId({ chatId: String(chatId) });
  }

  getModel() {
    return createModel(this.env);
  }

  getSystemPrompt() {
    return (
      "You are Mizook, a helpful assistant. Keep replies concise unless the user asks for detail.\n\n" +
      "Write like a real person, not a bot. No markdown, no formatting syntax, no asterisks for bold. " +
      "If you need structure, use natural text: line breaks, indentation, or simple dashes. " +
      "The goal is to feel like chatting with a knowledgeable friend, not reading a document.\n\n" +
      "Use web_search_exa to search the internet for current information, facts, or news. " +
      "Use web_fetch_exa to get the full content of a specific URL when you need details from a page. " +
      "Always search the web when the user asks about real-world events, recent data, or anything you are unsure about.\n\n" +
      "You have reminder capabilities. When the user asks to be reminded about something: " +
      "call set_reminder with a cron expression and the reminder message. " +
      "Use list_reminders to show active reminders and delete_reminder to cancel them."
    );
  }

  configureSession(session: Session) {
    return configureSession(session, this, this.env);
  }

  getTools(): ToolSet {
    return createReminderTools(this);
  }

  sendReminder(payload: ReminderPayload) {
    return Effect.gen({ self: this }, function* () {
      const tid = this.telegramThreadId(payload.chatId);
      yield* Effect.tryPromise(() =>
        this.getTelegram().postMessage(tid, `\u23f0 Reminder: ${payload.message}`),
      );
    }).pipe(Effect.runPromise);
  }

  onStart() {
    return Effect.gen({ self: this }, function* () {
      const provider = new AgentContextProvider(this, "soul");
      const stored = yield* Effect.tryPromise(() => provider.get());
      if (Option.isNone(Option.fromNullOr(stored))) {
        yield* Effect.tryPromise(() => provider.set(this.getSystemPrompt()));
      }

      if (this.env.EXA_API_KEY) {
        yield* Effect.tryPromise(() =>
          this.addMcpServer("exa", `https://mcp.exa.ai/mcp?exaApiKey=${this.env.EXA_API_KEY}`),
        );
      }
    }).pipe(Effect.runPromise);
  }

  @callable()
  resetChat() {
    return Effect.gen({ self: this }, function* () {
      this.resetTurnState();
      this.clearMessages();
      yield* Effect.tryPromise(() => this.session.refreshSystemPrompt());
    }).pipe(Effect.runPromise);
  }

  @callable()
  submitTelegramMessage(input: {
    chatId: number;
    messageId: number;
    text: string;
    thread: SerializedThread;
  }) {
    const self = this;
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      self.serializedThread = Option.some(input.thread);
      self._turnState = Option.some({
        platform: "telegram",
        chatId: input.chatId,
        replyToMessageId: input.messageId,
        startTime: now,
      });
      self.turnLog = Option.some(
        createScopedLogger({
          action: "turn",
          chat_id: input.chatId,
          message_id: input.messageId,
          platform: "telegram",
          phase: "submitted",
        }),
      );
      yield* Effect.tryPromise(() =>
        self.saveMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: input.text }],
            createdAt: new Date(),
          },
        ]),
      );
    }).pipe(Effect.runPromise);
  }

  @callable()
  submitDiscordMessage(input: {
    threadId: string;
    messageId: string;
    text: string;
    thread: SerializedThread;
  }) {
    const self = this;
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      self.serializedThread = Option.some(input.thread);
      self._turnState = Option.some({
        platform: "discord",
        threadId: input.threadId,
        replyToMessageId: input.messageId,
        startTime: now,
      });
      self.turnLog = Option.some(
        createScopedLogger({
          action: "turn",
          thread_id: input.threadId,
          message_id: input.messageId,
          platform: "discord",
          phase: "submitted",
        }),
      );
      yield* Effect.tryPromise(() =>
        self.saveMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: input.text }],
            createdAt: new Date(),
          },
        ]),
      );
    }).pipe(Effect.runPromise);
  }

  override beforeTurn(_ctx: TurnContext) {
    return Effect.gen({ self: this }, function* () {
      const freshSystem = yield* Effect.tryPromise(() => this.session.refreshSystemPrompt());
      const turn = this._turnState;
      if (Option.isNone(turn)) return { system: freshSystem };
      if (Option.isSome(this.turnLog)) {
        this.turnLog.value.set({ detail: { phase: "before_turn" } });
      }
      if (Option.isNone(this.serializedThread)) return { system: freshSystem };
      const { readable, writable } = new TransformStream<string, string>();
      this.streamWriter = Option.some(writable.getWriter());
      const adapter = turn.value.platform === "telegram" ? this.getTelegram() : this.getDiscord();
      const thread = ThreadImpl.fromJSON(this.serializedThread.value, adapter);
      yield* Effect.tryPromise(() => thread.startTyping());
      this.pendingStream = Option.some(
        thread.post(readable).catch((err) => {
          Effect.logError("stream failed:", err);
        }),
      );
      return { system: freshSystem };
    }).pipe(Effect.runPromise);
  }

  override onChunk({ chunk }: ChunkContext) {
    if (chunk.type !== "text-delta" || !chunk.text) return;
    void Option.getOrNull(this.streamWriter)?.write(chunk.text);
  }

  private cleanupStream() {
    return Effect.gen({ self: this }, function* () {
      const writer = Option.getOrNull(this.streamWriter);
      if (writer) yield* Effect.tryPromise(() => writer.close());
      const stream = Option.getOrNull(this.pendingStream);
      if (stream) yield* Effect.tryPromise(() => stream);
      this.streamWriter = Option.none();
      this.pendingStream = Option.none();
    });
  }

  override onChatResponse(result: ChatResponseResult) {
    return Effect.gen({ self: this }, function* () {
      yield* this.cleanupStream();
      this.serializedThread = Option.none();
      const turn = this._turnState;
      this._turnState = Option.none();
      if (Option.isSome(this.turnLog)) {
        const now = yield* Clock.currentTimeMillis;
        this.turnLog.value.set({
          detail: {
            phase: "complete",
            requestId: result.requestId,
            model: this.env.OPENCODE_GO_MODEL ?? "deepseek-v4-flash",
            latencyMs: Option.match(turn, {
              onSome: (t) => now - t.startTime,
              onNone: () => 0,
            }),
            result: result.status,
            platform: Option.getOrNull(turn)?.platform,
          },
        });
        this.turnLog.value.emit({ message: "turn_complete" });
        this.turnLog = Option.none();
      }
    }).pipe(Effect.runPromise);
  }

  override onChatError(error: unknown) {
    return Effect.gen({ self: this }, function* () {
      yield* this.cleanupStream();
      const turn = this._turnState;
      this._turnState = Option.none();
      if (Option.isSome(turn) && Option.isSome(this.serializedThread)) {
        const adapter = turn.value.platform === "telegram" ? this.getTelegram() : this.getDiscord();
        const thread = ThreadImpl.fromJSON(this.serializedThread.value, adapter);
        yield* Effect.tryPromise(() => thread.post("Sorry, something went wrong."));
      }
      this.serializedThread = Option.none();
      if (Option.isSome(this.turnLog)) {
        this.turnLog.value.set({
          detail: {
            phase: "error",
            error: error instanceof Error ? error.message : String(error),
            platform: Option.getOrNull(turn)?.platform,
          },
        });
        this.turnLog.value.emit({ message: "turn_error" });
        this.turnLog = Option.none();
      }
      return error;
    }).pipe(Effect.runPromise);
  }
}
