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
    // The dashboard at /admin sits behind Access. Login is GitHub when its OAuth app is given
    // (https://github.com/settings/developers, callback `https://<team>/cdn-cgi/access/callback`);
    // otherwise Access offers whatever login methods the account already has.
    const teamDomain = yield* Config.String("ACCESS_TEAM_DOMAIN");
    const githubId = yield* optional("GH_CLIENT_ID");
    const githubSecret = yield* Config.Redacted("GH_CLIENT_SECRET").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const github =
      githubId !== "" && Redacted.value(githubSecret) !== ""
        ? yield* Cloudflare.Access.IdentityProvider("GitHub", {
            type: "github",
            config: { clientId: githubId, clientSecret: githubSecret },
          })
        : undefined;
    const admin = yield* Cloudflare.Access.Application("Admin", {
      type: "self_hosted",
      name: "Mizook dashboard",
      domain: `${DOMAIN}/admin*`,
      sessionDuration: "24h",
      ...(github && {
        allowedIdps: [github.identityProviderId],
        autoRedirectToIdentity: true,
      }),
      policies: [{ decision: "allow", include: [{ email: yield* Config.String("ADMIN_EMAIL") }] }],
    });

    const worker = yield* Cloudflare.Worker("Mizook", {
      main: "./src/worker.ts",
      // The dashboard, built by `pnpm --filter @mizook/dashboard build`. Every request goes through
      // the Worker first, so the Access check runs before any file is served.
      assets: { directory: "./apps/dashboard/dist", base: "/admin", runWorkerFirst: true },
      domain: { name: DOMAIN },
      compatibility: { date: "2026-05-08", flags: ["nodejs_compat"] },
      env: {
        // The chat: one Durable Object owns the memory, pi-durable, and the bot.
        ChatAgent: Cloudflare.DurableObject<ChatAgent>("ChatAgent"),
        // The registry of channels.
        Hub: Cloudflare.DurableObject<Hub>("Hub"),
        // Artifacts, exports and backups.
        Files: files,
        // Voice notes, images and documents the user sends.
        AI: Cloudflare.Workers.AI(),
        // Pages that need JavaScript, and screenshots.
        BROWSER: Cloudflare.Workers.Browser(),
        PUBLIC_URL: `https://${DOMAIN}`,
        // The Worker checks the Access token itself: the team and the application's audience.
        ACCESS_TEAM_DOMAIN: teamDomain,
        ACCESS_AUD: admin.aud,

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
