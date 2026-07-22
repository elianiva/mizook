import { Effect, Schema } from "effect";
import {
  Think,
  type ActionAuthorizationDecision,
  type Session,
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
import { type ToolSet } from "ai";

import type { Env } from "./env";
import { getRuntime, type AppServices } from "./runtime";
import { createModel, summarize } from "./model";
import { basePrompt } from "./prompts/base";
import { composePrompt } from "./prompts/composer";
import { remindersPrompt } from "../features/reminders/prompts/reminders";
import { browserPrompt } from "../features/browser/prompts/browser";
import { createReminderTools, type ReminderPayload } from "../features/reminders/tools";
import { createBrowserTools } from "../features/browser/tools";
import { StorageError } from "./errors";
import { remindersToolDefinition } from "./registry/builtin/reminders";
import { browserToolDefinition } from "./registry/builtin/browser";

export { ThinkMessengerStateAgent };

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
    return createModel(this.env, this.env.OPENCODE_GO_MODEL ?? "mimo-v2.5-pro");
  }

  getMessengers() {
    return {
      telegram: telegramMessenger({
        token: this.env.BOT_TOKEN,
        userName: "mizook",
        secretToken: this.env.MIZOOK_WEBHOOK_SECRET,
        conversation: "self",
        respondTo: ["direct-message", "mention", "subscribed-thread", "action"],
      }),
    };
  }

  getSystemPrompt() {
    const tz = this.getConfiguredTimezone();
    const fullBase = [basePrompt, remindersPrompt.replace("{{TIMEZONE}}", tz), browserPrompt].join(
      "\n\n",
    );

    const mcpServers: Array<string> = [];
    if (this.env.EXA_API_KEY) mcpServers.push("exa");
    if (this.env.CF_API_TOKEN) mcpServers.push("cloudflare");

    return composePrompt({
      basePrompt: fullBase,
      tools: [remindersToolDefinition, browserToolDefinition],
      mcpServers,
    });
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
      .compactAfter(80_000)
      .withCachedPrompt();
  }

  configureSession(session: Session) {
    return this._applySessionConfig(session);
  }

  getTools(): ToolSet {
    return {
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
          const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: `\u23f0 Reminder: ${payload.message}`,
            }),
          });
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

  override authorizeTurn(_ctx: TurnContext): ActionAuthorizationDecision {
    const messenger = this.getMessengerContext();
    if (!messenger) return true;

    const allowedRaw = this.env.TELEGRAM_ALLOWED_USER_IDS;
    if (!allowedRaw) return true;

    const allowed = parseAllowedIds(allowedRaw);
    if (allowed.has(Number(messenger.author?.userId))) return true;

    return { allowed: false, reason: "Access denied." };
  }
}
