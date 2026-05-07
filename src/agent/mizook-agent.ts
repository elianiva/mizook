import { callable } from "agents";
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
  private _turnState: TurnState | null = null;
  private streamWriter: WritableStreamDefaultWriter<string> | null = null;
  private pendingStream: Promise<unknown> | null = null;
  private serializedThread: SerializedThread | null = null;
  private turnLog: ReturnType<typeof createScopedLogger> | null = null;
  private _telegram: TelegramAdapter | null = null;
  private _discord: DiscordAdapter | null = null;

  getTurnState(): TurnState | null {
    return this._turnState;
  }

  private getTelegram(): TelegramAdapter {
    if (!this._telegram) {
      this._telegram = createTelegramAdapter({ botToken: this.env.BOT_TOKEN });
    }
    return this._telegram;
  }

  private getDiscord(): DiscordAdapter {
    if (!this._discord) {
      this._discord = createDiscordAdapter({
        botToken: this.env.DISCORD_BOT_TOKEN,
        publicKey: this.env.DISCORD_PUBLIC_KEY,
        applicationId: this.env.DISCORD_APPLICATION_ID,
      });
    }
    return this._discord;
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

  async sendReminder(payload: ReminderPayload) {
    const tid = this.telegramThreadId(payload.chatId);
    await this.getTelegram().postMessage(tid, `\u23f0 Reminder: ${payload.message}`);
  }

  async onStart() {
    const provider = new AgentContextProvider(this, "soul");
    const stored = await provider.get();
    if (stored === null) {
      await provider.set(this.getSystemPrompt());
    }
  }

  @callable()
  async resetChat() {
    this.resetTurnState();
    this.clearMessages();
    await this.session.refreshSystemPrompt();
  }

  @callable()
  async submitTelegramMessage(input: {
    chatId: number;
    messageId: number;
    text: string;
    thread: SerializedThread;
  }) {
    this.serializedThread = input.thread;
    this._turnState = {
      platform: "telegram",
      chatId: input.chatId,
      replyToMessageId: input.messageId,
      startTime: Date.now(),
    };

    this.turnLog = createScopedLogger({
      action: "turn",
      chat_id: input.chatId,
      message_id: input.messageId,
      platform: "telegram",
      phase: "submitted",
    });

    await this.saveMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: input.text }],
        createdAt: new Date(),
      },
    ]);
  }

  @callable()
  async submitDiscordMessage(input: {
    threadId: string;
    messageId: string;
    text: string;
    thread: SerializedThread;
  }) {
    this.serializedThread = input.thread;
    this._turnState = {
      platform: "discord",
      threadId: input.threadId,
      replyToMessageId: input.messageId,
      startTime: Date.now(),
    };

    this.turnLog = createScopedLogger({
      action: "turn",
      thread_id: input.threadId,
      message_id: input.messageId,
      platform: "discord",
      phase: "submitted",
    });

    await this.saveMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: input.text }],
        createdAt: new Date(),
      },
    ]);
  }

  override async beforeTurn(_ctx: TurnContext) {
    const freshSystem = await this.session.refreshSystemPrompt();

    const turn = this._turnState;
    if (!turn) return { system: freshSystem };

    if (this.turnLog) {
      this.turnLog.set({ detail: { phase: "before_turn" } });
    }

    if (!this.serializedThread) return { system: freshSystem };

    const { readable, writable } = new TransformStream<string, string>();
    this.streamWriter = writable.getWriter();

    const adapter = turn.platform === "telegram" ? this.getTelegram() : this.getDiscord();
    const thread = ThreadImpl.fromJSON(this.serializedThread, adapter);

    await thread.startTyping();
    this.pendingStream = thread.post(readable).catch((err) => {
      console.error("stream failed:", err);
    });

    return { system: freshSystem };
  }

  override async onChunk({ chunk }: ChunkContext) {
    if (chunk.type !== "text-delta" || !chunk.text) return;
    void this.streamWriter?.write(chunk.text);
  }

  override async onChatResponse(result: ChatResponseResult) {
    await this.streamWriter?.close();
    await this.pendingStream;
    this.streamWriter = null;
    this.pendingStream = null;
    this.serializedThread = null;

    const turn = this._turnState;
    this._turnState = null;

    if (this.turnLog) {
      this.turnLog.set({
        detail: {
          phase: "complete",
          requestId: result.requestId,
          model: this.env.OPENCODE_GO_MODEL ?? "deepseek-v4-flash",
          latencyMs: turn ? Date.now() - turn.startTime : 0,
          result: result.status,
          platform: turn?.platform,
        },
      });
      this.turnLog.emit({ message: "turn_complete" });
      this.turnLog = null;
    }
  }

  override async onChatError(error: unknown) {
    await this.streamWriter?.close();
    await this.pendingStream;
    this.streamWriter = null;
    this.pendingStream = null;

    const turn = this._turnState;
    this._turnState = null;

    if (turn && this.serializedThread) {
      const adapter = turn.platform === "telegram" ? this.getTelegram() : this.getDiscord();
      const thread = ThreadImpl.fromJSON(this.serializedThread, adapter);
      await thread.post("Sorry, something went wrong.");
    }

    this.serializedThread = null;

    if (this.turnLog) {
      this.turnLog.set({
        detail: {
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
          platform: turn?.platform,
        },
      });
      this.turnLog.emit({ message: "turn_error" });
      this.turnLog = null;
    }

    return error;
  }
}
