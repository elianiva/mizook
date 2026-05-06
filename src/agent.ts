import { callable } from "agents";
import {
  Think,
  type ChunkContext,
  type ChatResponseResult,
  type Session,
  type TurnContext,
} from "@cloudflare/think";
import type { ToolSet } from "ai";
import { generateText, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { TelegramAdapter } from "@chat-adapter/telegram";
import { createDiscordAdapter } from "@chat-adapter/discord";
import type { DiscordAdapter } from "@chat-adapter/discord";
import type { DiscordGatewayDO } from "discord-gateway-cloudflare-do";
import type { ChatStateDO } from "chat-state-cloudflare-do";
import { createScopedLogger } from "./logger";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { AgentSearchProvider, AgentContextProvider } from "agents/experimental/memory/session";
import { ThreadImpl, type SerializedThread } from "chat";

export interface Env {
  AI: Ai;
  BOT_TOKEN: string;
  MIZOOK_AGENT: DurableObjectNamespace<MizookAgent>;
  CHAT_STATE: DurableObjectNamespace<ChatStateDO>;
  OPENCODE_GO_API_KEY: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
  OPENCODE_GO_MODEL?: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_GATEWAY_SECRET: string;
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGatewayDO>;
}

type ReminderPayload = {
  chatId: number;
  message: string;
};

type TurnState =
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
  private turnState: TurnState | null = null;
  private streamWriter: WritableStreamDefaultWriter<string> | null = null;
  private pendingStream: Promise<unknown> | null = null;
  private serializedThread: SerializedThread | null = null;
  private turnLog: ReturnType<typeof createScopedLogger> | null = null;
  private _telegram: TelegramAdapter | null = null;
  private _discord: DiscordAdapter | null = null;

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
    const opencode = createOpenAICompatible({
      baseURL: "https://opencode.ai/zen/go/v1",
      name: "Opencode Go",
      apiKey: this.env.OPENCODE_GO_API_KEY,
      fetch: this.fetchWithTimeout(60_000),
    });
    return opencode.chatModel(this.env.OPENCODE_GO_MODEL ?? "deepseek-v4-flash");
  }

  private fetchWithTimeout(timeout: number) {
    return async (url: RequestInfo | URL, options?: RequestInit) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          throw new Error(`Model request timed out after ${timeout}ms`);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    };
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
          summarize: (prompt) =>
            generateText({
              model: this.getModel(),
              prompt,
            }).then((r) => r.text),
        }),
      )
      .compactAfter(100_000)
      .withCachedPrompt();
  }

  getTools(): ToolSet {
    return {
      set_reminder: tool({
        description:
          "Set a recurring reminder using a cron schedule. " +
          "Use when the user asks to be reminded at regular intervals. " +
          "Examples: 'every day at 7am' -> cron '0 7 * * *', " +
          "'every Monday at 9am' -> cron '0 9 * * 1', " +
          "'weekdays at 8am' -> cron '0 8 * * 1-5'",
        inputSchema: z.object({
          cron: z
            .string()
            .describe(
              "Cron expression (minute hour day month weekday). " +
              "Examples: '0 7 * * *' = daily at 7am, " +
              "'0 9 * * 1' = Mondays at 9am, " +
              "'0 8 * * 1-5' = weekdays at 8am",
            ),
          message: z.string().describe("The reminder message text"),
        }),
        execute: async ({ cron, message }) => {
          const turn = this.turnState;
          if (!turn || turn.platform !== "telegram")
            return "Reminders are only available in private chat.";

          const schedule = await this.schedule(cron, "sendReminder", {
            chatId: turn.chatId,
            message,
          } satisfies ReminderPayload);

          return `Reminder set. ID: ${schedule.id}. I will remind you: "${message}"`;
        },
      }),

      list_reminders: tool({
        description: "List all active reminders",
        inputSchema: z.object({}),
        execute: async () => {
          const all = await this.listSchedules();
          const reminders = all.filter((s) => s.callback === "sendReminder");

          if (reminders.length === 0) return "No active reminders.";

          return reminders
            .map((s) => {
              const p = s.payload as ReminderPayload;
              const next = new Date(s.time * 1000).toLocaleString();
              const kind =
                s.type === "cron" && "cron" in s
                  ? `cron: ${(s as typeof s & { cron: string }).cron}`
                  : s.type;
              return `[${s.id.slice(0, 8)}…] ${p.message} — next: ${next} (${kind})`;
            })
            .join("\n");
        },
      }),

      delete_reminder: tool({
        description: "Cancel a reminder by its ID",
        inputSchema: z.object({
          scheduleId: z.string().describe("The schedule ID of the reminder to cancel"),
        }),
        execute: async ({ scheduleId }) => {
          const cancelled = await this.cancelSchedule(scheduleId);
          return cancelled
            ? `Reminder ${scheduleId.slice(0, 8)}… cancelled.`
            : `Reminder not found or already executed.`;
        },
      }),
    };
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
    this.turnState = {
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
    this.turnState = {
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

    const turn = this.turnState;
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

    const turn = this.turnState;
    this.turnState = null;

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

    const turn = this.turnState;
    this.turnState = null;

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
