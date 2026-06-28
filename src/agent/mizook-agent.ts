import { callable } from "agents";
import { Effect, Clock, Random } from "effect";
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
import { AgentContextProvider } from "agents/experimental/memory/session";
import { ThreadImpl, type SerializedThread } from "chat";
import type { Env } from "../env";
import { createScopedLogger } from "../logger";
import { createModel, DEFAULT_MODEL } from "./model";
import { configureSession } from "./session";
import type { ReminderPayload } from "../lib/errors";
import { createReminderTools } from "../tools/reminders";
import { createBrowserTools, type ChatTarget } from "../tools/browser-run";

export type TurnState = {
  platform: "telegram";
  chatId: number;
  replyToMessageId?: number;
  startTime: number;
};

export class MizookAgent extends Think<Env> {
  private turnState: TurnState | null = null;
  private streamWriter: WritableStreamDefaultWriter<string> | null = null;
  private pendingStream: Promise<unknown> | null = null;
  private serializedThread: SerializedThread | null = null;
  private turnLog: ReturnType<typeof createScopedLogger> | null = null;
  private telegram: TelegramAdapter | null = null;
  waitForMcpConnections = { timeout: 10_000 } as const;

  getTurnState(): TurnState | null {
    return this.turnState;
  }

  getConfiguredTimezone(): string {
    return this.env.TIMEZONE ?? "Asia/Jakarta";
  }

  private getTelegram(): TelegramAdapter {
    if (!this.telegram) {
      this.telegram = createTelegramAdapter({ botToken: this.env.BOT_TOKEN });
    }
    return this.telegram;
  }

  private telegramThreadId(chatId: number): string {
    return this.getTelegram().encodeThreadId({ chatId: String(chatId) });
  }

  getModel() {
    return createModel(this.env);
  }

  getSystemPrompt() {
    const tz = this.env.TIMEZONE ?? "UTC+7";
    return (
      "You are Mizook, a helpful assistant. Keep replies concise unless the user asks for detail.\n\n" +
      "Write like a real person, not a bot. No markdown, no formatting syntax, no asterisks for bold. " +
      "If you need structure, use natural text: line breaks, indentation, or simple dashes. " +
      "The goal is to feel like chatting with a knowledgeable friend, not reading a document.\n\n" +
      "Use web_search_exa to search the internet for current information, facts, or news. " +
      "Use web_fetch_exa to get the full content of a specific URL when you need details from a page. " +
      "Always search the web when the user asks about real-world events, recent data, or anything you are unsure about.\n\n" +
      `Your timezone is ${tz}. The user's timezone is ${tz}. ` +
      "When they say times like '8am' or 'noon', they mean that time in this timezone. " +
      "Cron expressions run on UTC, so you must convert local times to UTC. " +
      "Example: user says 'remind me at 8am daily' -> cron '0 1 * * *' (8am UTC+7 = 1am UTC). " +
      "Example: 'weekdays at 9am' -> cron '0 2 * * 1-5' (9am UTC+7 = 2am UTC). " +
      "Example: 'every Monday at midnight' -> cron '0 17 * * 0' (Mon 0:00 UTC+7 = Sun 17:00 UTC).\n\n" +
      "You have reminder capabilities. " +
      "For one-time reminders, call set_reminder with a duration (e.g. '30m', '2h') and message. " +
      "For recurring reminders, call set_reminder with a cron expression and message. " +
      "Use list_reminders to show active reminders and delete_reminder to cancel them.\n\n" +
      "You have browser capabilities using Cloudflare Browser Run. " +
      "When the user asks you to visit a website, take a screenshot, or check a page, " +
      "use browser_screenshot_and_send to capture and send the screenshot directly to them. " +
      "Use browser_screenshot to just capture (returns an R2 key). " +
      "Use send_photo_to_chat with an R2 key to send a previously taken screenshot.\n\n" +
      "You have full access to the Cloudflare API via the `search` and `execute` tools. " +
      "When the user asks about their Cloudflare resources (domains, DNS, Workers, KV, R2, D1, etc.), " +
      "use `search` to find the right API endpoints, then `execute` to make the API call. " +
      "Example: 'check my domains' -> search for zone list endpoints, then execute GET /client/v4/zones. " +
      "Example: 'add a CNAME for x.example.com to y.example.com' -> search DNS record create, then execute POST. " +
      "For endpoints that need an account_id, search for the account first or ask the user."
    );
  }

  configureSession(session: Session) {
    return configureSession(session, this, this.env);
  }

  getTools(): ToolSet {
    return {
      ...createReminderTools(this, this.getConfiguredTimezone()),
      ...createBrowserTools(
        {
          BROWSER: this.env.BROWSER,
          SCREENSHOTS: this.env.SCREENSHOTS,
          BOT_TOKEN: this.env.BOT_TOKEN,
        },
        (): ChatTarget => {
          const ts = this.turnState;
          if (ts) return { platform: "telegram", chatId: ts.chatId };
          return { platform: "unknown" };
        },
      ),
    };
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
  submitTelegramMessage(input: {
    chatId: number;
    messageId: number;
    text: string;
    thread: SerializedThread;
  }) {
    return Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis;
      this.serializedThread = input.thread;
      this.turnState = {
        platform: "telegram",
        chatId: input.chatId,
        replyToMessageId: input.messageId,
        startTime: now,
      };
      this.turnLog = createScopedLogger({
        action: "turn",
        chat_id: input.chatId,
        message_id: input.messageId,
        platform: "telegram",
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
      const { readable, writable } = new TransformStream<string, string>();
      this.streamWriter = writable.getWriter();
      const adapter = this.getTelegram();
      const thread = ThreadImpl.fromJSON(this.serializedThread, adapter);
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
            platform: turn?.platform,
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
        const adapter = this.getTelegram();
        const thread = ThreadImpl.fromJSON(this.serializedThread, adapter);
        yield* Effect.tryPromise(() => thread.post("Sorry, something went wrong."));
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
        if (error instanceof Error) this.turnLog.error(error);
        this.turnLog.emit({ message: "turn_error" });
        this.turnLog = null;
      }
      return error;
    }).pipe(Effect.runPromise);
  }
}
