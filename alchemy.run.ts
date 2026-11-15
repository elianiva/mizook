import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { ChatAgent } from "./src/chat-agent.ts";

/** A plain variable the bot reads at runtime. Left empty it is ignored, and the bot uses its own default. */
const optional = (name: string) => Config.String(name).pipe(Config.withDefault(""));

export default Alchemy.Stack(
  "mizook",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("Mizook", {
      main: "./src/worker.ts",
      compatibility: { date: "2026-05-08", flags: ["nodejs_compat"] },
      env: {
        // The chat: one Durable Object owns the memory, pi-durable, and the bot.
        ChatAgent: Cloudflare.DurableObject<ChatAgent>("ChatAgent"),

        BOT_TOKEN: Config.Redacted("BOT_TOKEN"),
        MIZOOK_WEBHOOK_SECRET: Config.Redacted("MIZOOK_WEBHOOK_SECRET"),
        DEEPSEEK_API_KEY: Config.Redacted("DEEPSEEK_API_KEY"),

        TELEGRAM_ALLOWED_USER_IDS: Config.String("TELEGRAM_ALLOWED_USER_IDS"),
        BOT_USERNAME: optional("BOT_USERNAME"),
        AGENT_NAME: optional("AGENT_NAME"),
        INSTRUCTIONS: optional("INSTRUCTIONS"),
        MODEL: optional("MODEL"),
        SUMMARY_MODEL: optional("SUMMARY_MODEL"),
        TIMEZONE: optional("TIMEZONE"),
      },
    });

    return { url: worker.url };
  }),
);
