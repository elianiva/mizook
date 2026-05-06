import { callable } from "agents";
import { Think, type ChatResponseResult, type Session, type TurnContext } from "@cloudflare/think";
import type { ToolSet } from "ai";
import { generateText, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { TelegramAdapter } from "@chat-adapter/telegram";
import type { ChatStateDO } from "chat-state-cloudflare-do";
import { createScopedLogger } from "./logger";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { AgentSearchProvider, AgentContextProvider } from "agents/experimental/memory/session";

export interface Env {
  AI: Ai;
  BOT_TOKEN: string;
  MIZOOK_AGENT: DurableObjectNamespace<MizookAgent>;
  CHAT_STATE: DurableObjectNamespace<ChatStateDO>;
  OPENCODE_GO_API_KEY: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
  OPENCODE_GO_MODEL?: string;
}

type ReminderPayload = {
  chatId: number;
  message: string;
};

type TurnState = {
  chatId: number;
  replyToMessageId?: number;
  startTime: number;
};

function extractChunkDelta(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const part = chunk as { type?: string; delta?: string; textDelta?: string; text?: string };
  if (part.type && part.type !== "text-delta") return "";
  return part.delta ?? part.textDelta ?? part.text ?? "";
}

type StreamController = {
  push: (text: string) => void;
  end: () => void;
  stream: AsyncIterable<string>;
};

function createStreamController(): StreamController {
  let resolveNext: ((value: string | null) => void) | null = null;
  const buffer: string[] = [];
  let done = false;

  return {
    push(text: string) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(text);
      } else {
        buffer.push(text);
      }
    },
    end() {
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(null);
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (buffer.length > 0) {
              return Promise.resolve({ value: buffer.shift()!, done: false });
            }
            if (done) return Promise.resolve({ value: undefined as unknown as string, done: true });
            return new Promise<IteratorResult<string>>((res) => {
              resolveNext = (value: string | null) => {
                res(
                  value === null
                    ? { value: undefined as unknown as string, done: true }
                    : { value, done: false },
                );
              };
            });
          },
        };
      },
    },
  };
}

export class MizookAgent extends Think<Env> {
  private turnState: TurnState | null = null;
  private streamController: StreamController | null = null;
  private turnLog: ReturnType<typeof createScopedLogger> | null = null;
  private pendingStream: Promise<void> | null = null;
  private _telegram: TelegramAdapter | null = null;

  private getTelegram(): TelegramAdapter {
    if (!this._telegram) {
      this._telegram = createTelegramAdapter({ botToken: this.env.BOT_TOKEN });
    }
    return this._telegram;
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
      "You are Mizook, a helpful Telegram assistant. Keep replies concise unless the user asks for detail.\n\n" +
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
          const chatId = this.turnState?.chatId;
          if (!chatId) return "Error: No active chat session.";

          const schedule = await this.schedule(cron, "sendReminder", {
            chatId,
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
  async submitTelegramMessage(input: { chatId: number; messageId: number; text: string }) {
    this.turnState = {
      chatId: input.chatId,
      replyToMessageId: input.messageId,
      startTime: Date.now(),
    };

    this.turnLog = createScopedLogger({
      action: "turn",
      chat_id: input.chatId,
      message_id: input.messageId,
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

    const tid = this.telegramThreadId(turn.chatId);
    await this.getTelegram().startTyping(tid);

    const controller = createStreamController();
    this.streamController = controller;

    this.pendingStream = this.streamToTelegram(tid, controller.stream).catch((err) => {
      console.error("streamToTelegram failed:", err);
    });

    return { system: freshSystem };
  }

  private async streamToTelegram(tid: string, stream: AsyncIterable<string>): Promise<void> {
    const tg = this.getTelegram();
    let sent: Awaited<ReturnType<typeof tg.postMessage>> | null = null;
    let accumulated = "";
    let lastEditTime = 0;
    const updateInterval = 500;

    for await (const chunk of stream) {
      accumulated += chunk;
      const now = Date.now();

      if (sent === null) {
        sent = await tg.postMessage(tid, accumulated || "\u2026");
      } else if (now - lastEditTime >= updateInterval) {
        tg.editMessage(tid, sent.id, accumulated).catch(() => { });
        lastEditTime = now;
      }
    }

    if (sent) {
      await tg.editMessage(tid, sent.id, accumulated).catch(() => { });
    }
  }

  override async onChunk({ chunk }: { chunk: unknown }) {
    const delta = extractChunkDelta(chunk);
    if (!delta) return;
    this.streamController?.push(delta);
  }

  override async onChatResponse(result: ChatResponseResult) {
    this.streamController?.end();
    this.streamController = null;
    await this.pendingStream;
    this.pendingStream = null;

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
        },
      });
      this.turnLog.emit({ message: "turn_complete" });
      this.turnLog = null;
    }
  }

  override async onChatError(error: unknown) {
    this.streamController?.end();
    this.streamController = null;
    await this.pendingStream;
    this.pendingStream = null;

    const turn = this.turnState;
    this.turnState = null;

    if (turn) {
      const tid = this.telegramThreadId(turn.chatId);
      await this.getTelegram().postMessage(tid, "Sorry, something went wrong.");
    }

    if (this.turnLog) {
      this.turnLog.set({
        detail: {
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      });
      this.turnLog.emit({ message: "turn_error" });
      this.turnLog = null;
    }

    return error;
  }
}
