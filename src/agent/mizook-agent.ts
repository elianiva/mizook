import { callable } from "agents";
import { Effect, Clock, Option, Random } from "effect";
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
import { createReminderTools } from "../tools/reminders";
import { createBrowserTools } from "../tools/browser-run";

type ReminderPayload = {
  chatId: number;
  message: string;
};

export type TurnState = {
  platform: "telegram";
  chatId: number;
  replyToMessageId?: number;
  startTime: number;
};

export class MizookAgent extends Think<Env> {
  private _turnState: Option.Option<TurnState> = Option.none();
  private streamWriter: Option.Option<WritableStreamDefaultWriter<string>> = Option.none();
  private pendingStream: Option.Option<Promise<unknown>> = Option.none();
  private serializedThread: Option.Option<SerializedThread> = Option.none();
  private turnLog: Option.Option<ReturnType<typeof createScopedLogger>> = Option.none();
  private _telegram: Option.Option<TelegramAdapter> = Option.none();
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
      "Use send_photo_to_chat with an R2 key to send a previously taken screenshot."
    );
  }

  configureSession(session: Session) {
    return configureSession(session, this, this.env);
  }

  getTools(): ToolSet {
    return {
      ...createReminderTools(this),
      ...createBrowserTools(
        {
          BROWSER: this.env.BROWSER,
          SCREENSHOTS: this.env.SCREENSHOTS,
          BOT_TOKEN: this.env.BOT_TOKEN,
        },
        () => {
          const turnState = this._turnState;
          if (Option.isSome(turnState)) {
            return { platform: "telegram" as const, chatId: turnState.value.chatId };
          }
          return { platform: "unknown" as const };
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
      const storedOpt = Option.fromNullOr(yield* Effect.tryPromise(() => provider.get()));
      if (Option.isNone(storedOpt)) {
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
      const id = yield* Random.nextUUIDv4;
      const createdAt = new Date(yield* Clock.currentTimeMillis);
      yield* Effect.tryPromise(() =>
        self.saveMessages((current) => [
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
      const turn = this._turnState;
      if (Option.isNone(turn)) return { system: freshSystem };
      if (Option.isSome(this.turnLog)) {
        this.turnLog.value.set({ detail: { phase: "before_turn" } });
      }
      if (Option.isNone(this.serializedThread)) return { system: freshSystem };
      const { readable, writable } = new TransformStream<string, string>();
      this.streamWriter = Option.some(writable.getWriter());
      const adapter = this.getTelegram();
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
            model: this.env.OPENCODE_GO_MODEL ?? DEFAULT_MODEL,
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
        const adapter = this.getTelegram();
        const thread = ThreadImpl.fromJSON(this.serializedThread.value, adapter);
        yield* Effect.tryPromise(() => thread.post("Sorry, something went wrong."));
      }
      this.serializedThread = Option.none();
      if (Option.isSome(this.turnLog)) {
        if (error instanceof Error) {
          this.turnLog.value.error(error, {
            detail: {
              phase: "error",
              platform: Option.getOrNull(turn)?.platform,
            },
          });
        } else {
          this.turnLog.value.set({
            detail: {
              phase: "error",
              error: String(error),
              platform: Option.getOrNull(turn)?.platform,
            },
          });
        }
        this.turnLog.value.emit({ message: "turn_error" });
        this.turnLog = Option.none();
      }
      return error;
    }).pipe(Effect.runPromise);
  }
}
