import { callable } from "agents";
import { Think, type ChatResponseResult, type Session, type TurnContext } from "@cloudflare/think";
import type { UIMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getTelegramApi } from "./telegram-client";
import { createScopedLogger } from "./logger";

export interface Env {
  AI: Ai;
  BOT_TOKEN: string;
  MIZOOK_AGENT: DurableObjectNamespace<MizookAgent>;
  OPENCODE_GO_API_KEY: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
  OPENCODE_GO_MODEL?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

type TelegramTurn = {
  chatId: number;
  requestId?: string;
  replyToMessageId?: number;
  messageIds: number[];
  renderedChunks: string[];
  buffer: string;
  lastEditAt: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushInFlight: Promise<void> | null;
  flushRequested: boolean;
  startTime: number;
};

const TELEGRAM_CHUNK_LIMIT = 3500;
const TELEGRAM_FLUSH_INTERVAL_MS = 300;

function extractText(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

function extractChunkDelta(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const part = chunk as { type?: string; delta?: string; textDelta?: string; text?: string };
  if (part.type !== "text-delta") return "";
  return part.delta ?? part.textDelta ?? part.text ?? "";
}

function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_CHUNK_LIMIT) {
    chunks.push(text.slice(i, i + TELEGRAM_CHUNK_LIMIT));
  }
  return chunks.length ? chunks : ["\u2026"];
}

function createTelegramTurn(input: { chatId: number; replyToMessageId?: number }): TelegramTurn {
  return {
    chatId: input.chatId,
    replyToMessageId: input.replyToMessageId,
    messageIds: [],
    renderedChunks: [],
    buffer: "",
    lastEditAt: 0,
    flushTimer: null,
    flushInFlight: null,
    flushRequested: false,
    startTime: Date.now(),
  };
}

export class MizookAgent extends Think<Env> {
  private telegramTurn: TelegramTurn | null = null;
  private turnLog: ReturnType<typeof createScopedLogger> | null = null;

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
    return "You are Mizook, a helpful Telegram assistant. Keep replies concise unless the user asks for detail.";
  }

  configureSession(session: Session) {
    return (
      session
        // TODO: dynamic soul with D1
        .withContext("soul", {
          provider: { get: async () => "You're a helpful assistant." },
        })
        .withCachedPrompt()
    );
  }

  @callable()
  resetChat() {
    this.resetTurnState();
    this.clearMessages();
    this.session.reset?.();
  }

  @callable()
  async submitTelegramMessage(input: { chatId: number; messageId: number; text: string }) {
    this.telegramTurn = createTelegramTurn({
      chatId: input.chatId,
      replyToMessageId: input.messageId,
    });

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
    const turn = this.telegramTurn;
    if (!turn) return;

    if (this.turnLog) {
      this.turnLog.set({ phase: "before_turn" });
    }

    const api = getTelegramApi(this.env.BOT_TOKEN);
    await api.sendChatAction(turn.chatId, "typing");

    if (turn.messageIds[0] != null) return;

    const sent = await api.sendMessage(
      turn.chatId,
      "Thinking\u2026",
      turn.replyToMessageId
        ? {
          reply_parameters: { message_id: turn.replyToMessageId },
        }
        : undefined,
    );

    turn.messageIds[0] = sent.message_id;
    turn.renderedChunks[0] = "Thinking\u2026";
    turn.lastEditAt = Date.now();
  }

  override async onChunk({ chunk }: { chunk: unknown }) {
    const turn = this.telegramTurn;
    if (!turn) return;

    const delta = extractChunkDelta(chunk);
    if (!delta) return;

    turn.buffer += delta;
    await this.scheduleTelegramFlush(turn);
  }

  override async onChatResponse(result: ChatResponseResult) {
    const turn = this.telegramTurn;
    this.telegramTurn = null;

    if (!turn || result.status !== "completed") {
      this.turnLog = null;
      return;
    }

    turn.buffer = extractText(result.message) || turn.buffer;
    await this.flushTelegramTurn(turn, true);

    if (this.turnLog) {
      this.turnLog.set({
        phase: "complete",
        requestId: result.requestId,
        model: this.env.OPENCODE_GO_MODEL ?? "deepseek-v4-flash",
        latencyMs: Date.now() - turn.startTime,
        result: result.status,
      });
      this.turnLog.emit();
      this.turnLog = null;
    }
  }

  override async onChatError(error: unknown) {
    const turn = this.telegramTurn;
    this.telegramTurn = null;

    if (turn) {
      const api = getTelegramApi(this.env.BOT_TOKEN);
      const hasRendered = turn.renderedChunks.some(Boolean);
      if (hasRendered) {
        try {
          await this.flushTelegramTurn(turn, true);
        } catch {
          // ignore partial flush failures
        }
      }
      await api.sendMessage(turn.chatId, "Sorry, something went wrong.");
    }

    if (this.turnLog) {
      this.turnLog.set({
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      this.turnLog.emit();
      this.turnLog = null;
    }

    return error;
  }

  private async scheduleTelegramFlush(turn: TelegramTurn) {
    if (turn.flushInFlight) {
      turn.flushRequested = true;
      return turn.flushInFlight;
    }

    const now = Date.now();
    const wait = TELEGRAM_FLUSH_INTERVAL_MS - (now - turn.lastEditAt);
    if (wait > 0) {
      turn.flushRequested = true;
      if (!turn.flushTimer) {
        turn.flushTimer = setTimeout(() => {
          turn.flushTimer = null;
          void this.flushTelegramTurn(turn, true).catch(() => { });
        }, wait);
      }
      return;
    }

    return this.flushTelegramTurn(turn, false);
  }

  private async flushTelegramTurn(turn: TelegramTurn, final: boolean) {
    if (turn.flushInFlight) {
      turn.flushRequested = true;
      return turn.flushInFlight;
    }

    if (turn.flushTimer) {
      clearTimeout(turn.flushTimer);
      turn.flushTimer = null;
    }

    const run = async () => {
      const api = getTelegramApi(this.env.BOT_TOKEN);
      const desired = splitTelegramText(turn.buffer);

      for (let i = 0; i < desired.length; i++) {
        const text = desired[i];
        const existingId = turn.messageIds[i];
        const previous = turn.renderedChunks[i];

        if (existingId == null) {
          const sent = await api.sendMessage(
            turn.chatId,
            text,
            i === 0 && turn.replyToMessageId
              ? {
                reply_parameters: { message_id: turn.replyToMessageId },
              }
              : undefined,
          );
          turn.messageIds[i] = sent.message_id;
          turn.renderedChunks[i] = text;
          continue;
        }

        if (previous !== text) {
          await api.editMessageText(turn.chatId, existingId, text);
          turn.renderedChunks[i] = text;
        }
      }

      if (final) {
        turn.flushRequested = false;
      }
    };

    turn.flushInFlight = run().finally(() => {
      turn.flushInFlight = null;
      turn.lastEditAt = Date.now();
      const pending = turn.flushRequested;
      turn.flushRequested = false;
      if (pending) void this.flushTelegramTurn(turn, true).catch(() => { });
    });

    return turn.flushInFlight;
  }
}
