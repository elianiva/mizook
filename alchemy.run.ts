import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { ChatAgent } from "./src/chat-agent.ts";
import type { Hub } from "./src/hub.ts";

/** A plain variable the bot reads at runtime. Left empty it is ignored, and the bot uses its own default. */
const optional = (name: string) => Config.String(name).pipe(Config.withDefault(""));

/** Where the Worker is served, and where artifact links point. The zone must exist in the account. */
const DOMAIN = "mzk.elianiva.com";

export default Alchemy.Stack(
  "mizook",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const files = yield* Cloudflare.R2.Bucket("Files");
    const worker = yield* Cloudflare.Worker("Mizook", {
      main: "./src/worker.ts",
      domain: { name: DOMAIN },
      compatibility: { date: "2026-05-08", flags: ["nodejs_compat"] },
      env: {
        // The chat: one Durable Object owns the memory, pi-durable, and the bot.
        ChatAgent: Cloudflare.DurableObject<ChatAgent>("ChatAgent"),
        // The registry of channels.
        Hub: Cloudflare.DurableObject<Hub>("Hub"),
        // Artifacts, exports and backups.
        Files: files,
        PUBLIC_URL: `https://${DOMAIN}`,
        // The dashboard at /admin: the Access application protecting it, from Zero Trust.
        ACCESS_TEAM_DOMAIN: optional("ACCESS_TEAM_DOMAIN"),
        ACCESS_AUD: optional("ACCESS_AUD"),

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
        BUDGET_DAILY: optional("BUDGET_DAILY"),
        SEARCH_PROVIDERS: optional("SEARCH_PROVIDERS"),
        PARALLEL_API_KEY: Config.Redacted("PARALLEL_API_KEY").pipe(
          Config.withDefault(Redacted.make("")),
        ),
        EXECUTOR_URL: optional("EXECUTOR_URL"),
        EXECUTOR_TOKEN: Config.Redacted("EXECUTOR_TOKEN").pipe(
          Config.withDefault(Redacted.make("")),
        ),
        EXA_API_KEY: Config.Redacted("EXA_API_KEY").pipe(Config.withDefault(Redacted.make(""))),
      },
    });

    return { url: worker.url };
  }),
);
