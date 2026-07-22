import { callable } from "agents";
import { Effect } from "effect";
import {
  Think,
  type Session,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import { ThinkMessengerStateAgent } from "@cloudflare/think/messengers";
import telegramMessenger from "@cloudflare/think/messengers/telegram";
import {
  AgentContextProvider,
  AgentSearchProvider,
  Session as AgentSession,
} from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Schema } from "effect";

import type { Env } from "./env";
import { getRuntime, type AppServices } from "./runtime";
import { createModel, summarize } from "./model";
import { basePrompt } from "./prompts/base";
import { remindersPrompt } from "../features/reminders/prompts/reminders";
import { browserPrompt } from "../features/browser/prompts/browser";
import { createReminderTools, type ReminderPayload } from "../features/reminders/tools";
import { createBrowserTools } from "../features/browser/tools";
import { StorageError } from "./errors";

export { ThinkMessengerStateAgent };

const modelOverrides = new Map<string, string>();

function parseAllowedIds(raw: string): Set<number> {
  try {
    return new Set(
      Schema.decodeSync(Schema.Array(Schema.NumberFromString))(
        raw.split(/[\s,]+/).filter(Boolean),
      ).filter(Number.isSafeInteger),
    );
  } catch {
    return new Set<number>();
  }
}

const COMMAND_INSTRUCTIONS =
  "You respond to Telegram slash commands. When the user sends:\n" +
  "  /help — List available commands\n" +
  "  /status — Call get_status to show current model and reminders\n" +
  "  /model [name] — Call set_model to show or switch the model\n" +
  "Respond concisely. Use the appropriate tool and report the result naturally.";

export class MizookAgent extends Think<Env> {
  waitForMcpConnections = false;

  private get runtime() {
    return getRuntime(this.env);
  }

  run<A, E, R extends AppServices>(eff: Effect.Effect<A, E, R>): Promise<A> {
    return this.runtime.runPromise(eff);
  }

  get appEnv() {
    return this.env;
  }

  getConfiguredTimezone(): string {
    return this.env.TIMEZONE ?? "Asia/Jakarta";
  }

  getModel() {
    return createModel(this.env, this.getModelName(this.getChatIdForModel()));
  }

  /** Derive the chat id for model-override lookup from the active context. */
  private getChatIdForModel(): string | undefined {
    const ctx = this.getMessengerContext();
    if (ctx) return ctx.thread.id;
    return undefined;
  }

  @callable()
  getModelName(chatId?: string): string {
    const id = chatId ?? this.getChatIdForModel();
    const override = id ? modelOverrides.get(id) : undefined;
    return override ?? this.env.OPENCODE_GO_MODEL ?? "mimo-v2.5-pro";
  }

  @callable()
  setModel(chatId: string, modelName: string) {
    modelOverrides.set(chatId, modelName);
  }

  getMessengers() {
    return {
      telegram: telegramMessenger({
        token: this.env.BOT_TOKEN,
        userName: "mizook",
        secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      }),
    };
  }

  getSystemPrompt() {
    const tz = this.getConfiguredTimezone();
    return [
      basePrompt,
      remindersPrompt.replace("{{TIMEZONE}}", tz),
      browserPrompt,
      COMMAND_INSTRUCTIONS,
    ].join("\n\n");
  }

  private _applySessionConfig(builder: AgentSession): AgentSession {
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
      .withCachedPrompt();
  }

  configureSession(session: Session) {
    return this._applySessionConfig(session);
  }

  getTools(): ToolSet {
    return {
      ...this.createCommandTools(),
      ...createReminderTools(this),
      ...createBrowserTools(this),
    };
  }

  sendReminder(payload: ReminderPayload) {
    const botToken = this.env.BOT_TOKEN;
    const chatId = payload.target.chatId;
    return this.runtime.runPromise(
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: `\u23f0 Reminder: ${payload.message}`,
              }),
            },
          );
          if (!res.ok) throw new Error(`sendMessage failed: ${res.status}`);
        },
        catch: (cause) => new StorageError({ cause }),
      }),
    );
  }

  override onStart(): Promise<void> {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        const provider = new AgentContextProvider(this, "soul");
        const stored = yield* Effect.tryPromise({
          try: () => provider.get(),
          catch: (cause) => new StorageError({ cause }),
        });
        if (!stored) {
          yield* Effect.tryPromise({
            try: () => provider.set(this.getSystemPrompt()),
            catch: (cause) => new StorageError({ cause }),
          });
        }
        if (this.env.EXA_API_KEY) {
          const exaKey = this.env.EXA_API_KEY;
          yield* Effect.tryPromise({
            try: () =>
              this.addMcpServer("exa", "https://mcp.exa.ai/mcp", {
                transport: { headers: { "x-api-key": exaKey } },
              }),
            catch: (cause) => new StorageError({ cause }),
          });
        }
        if (this.env.CF_API_TOKEN) {
          yield* Effect.tryPromise({
            try: () =>
              this.addMcpServer("cloudflare", "https://mcp.cloudflare.com/mcp", {
                transport: { headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` } },
              }),
            catch: (cause) => new StorageError({ cause }),
          });
        }
        yield* Effect.logInfo("agent_onStart_done");
      }),
    );
  }

  override beforeTurn(_ctx: TurnContext): TurnConfig | void | Promise<TurnConfig | void> {
    const messenger = this.getMessengerContext();
    if (!messenger) return;

    // Access control — only applies to telegram messenger
    const allowedRaw = this.env.TELEGRAM_ALLOWED_USER_IDS;
    if (allowedRaw) {
      const allowed = parseAllowedIds(allowedRaw);
      if (!allowed.has(Number(messenger.author?.userId))) {
        void this.deliverNotice("Access denied.");
        return {
          system: "### System: The user is not authorized to use this bot. Do not respond.",
          maxSteps: 0,
        };
      }
    }
  }

  private createCommandTools(): ToolSet {
    const agent = this;
    const AVAILABLE = ["deepseek-v4-flash", "kimi-k2.6", "deepseek-v4-pro", "mimo-v2.5-pro"];

    return {
      get_status: tool({
        description: "Show bot status: current model and active reminders. Use when the user sends /status.",
        inputSchema: z.object({}),
        execute: async () => {
          const chatId = agent.getChatIdForModel() ?? "";
          const modelName = agent.getModelName(chatId);
          const schedules = await agent.listSchedules();
          const reminderCount = schedules.filter(
            (s: { callback: string }) => s.callback === "sendReminder",
          ).length;
          return `Model: ${modelName}\nActive reminders: ${reminderCount}`;
        },
      }),
      set_model: tool({
        description:
          "Show or set the AI model. Without modelName, returns the current model and available options. " +
          "With modelName, switches to that model. Use when the user sends /model.",
        inputSchema: z.object({
          modelName: z.string().optional().describe("The model name to switch to, or empty to show current"),
        }),
        execute: async ({ modelName }) => {
          const chatId = agent.getChatIdForModel() ?? "";
          if (!modelName) {
            const current = agent.getModelName(chatId);
            return `Current model: ${current}\nAvailable: ${AVAILABLE.join(", ")}`;
          }
          if (!AVAILABLE.includes(modelName)) {
            return `Unknown model "${modelName}". Available: ${AVAILABLE.join(", ")}`;
          }
          agent.setModel(chatId, modelName);
          return `Model set to ${modelName}`;
        },
      }),
    };
  }

}
