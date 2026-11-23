import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { AgentObject } from "./src/agent-object.ts";
import type { AutomationsObject } from "./src/automations-object.ts";
import type { Hub } from "./src/hub.ts";
import type { WebChatObject } from "./src/web-chat-object.ts";

const emptyMeansDefault = (name: string) => Config.String(name).pipe(Config.withDefault(""));

const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")));

const DOMAIN = "mzk.elianiva.com";

export default Alchemy.Stack(
  "mizook",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const files = yield* Cloudflare.R2.Bucket("Files");
    const accessTeamDomain = yield* Config.String("ACCESS_TEAM_DOMAIN");
    const githubOAuthClientId = yield* emptyMeansDefault("GH_CLIENT_ID");
    const githubOAuthClientSecret = yield* optionalSecret("GH_CLIENT_SECRET");
    const githubOAuthAppIsGiven =
      githubOAuthClientId !== "" && Redacted.value(githubOAuthClientSecret) !== "";
    const githubProvider = githubOAuthAppIsGiven
      ? yield* Cloudflare.Access.IdentityProvider("GitHub", {
          type: "github",
          config: { clientId: githubOAuthClientId, clientSecret: githubOAuthClientSecret },
        })
      : undefined;
    const dashboardAccessApplication = yield* Cloudflare.Access.Application("Admin", {
      type: "self_hosted",
      name: "Mizook dashboard",
      domain: `${DOMAIN}/admin*`,
      sessionDuration: "24h",
      ...(githubProvider && {
        allowedIdps: [githubProvider.identityProviderId],
        autoRedirectToIdentity: true,
      }),
      policies: [{ decision: "allow", include: [{ email: yield* Config.String("ADMIN_EMAIL") }] }],
    });

    const chatAccessApplication = yield* Cloudflare.Access.Application("WebChat", {
      type: "self_hosted",
      name: "Mizook web chat",
      domain: `${DOMAIN}/c*`,
      sessionDuration: "24h",
      ...(githubProvider && {
        allowedIdps: [githubProvider.identityProviderId],
        autoRedirectToIdentity: true,
      }),
      policies: [{ decision: "allow", include: [{ email: yield* Config.String("ADMIN_EMAIL") }] }],
    });

    const worker = yield* Cloudflare.Worker("Mizook", {
      main: "./src/worker.ts",
      assets: { directory: "./dist", runWorkerFirst: true },
      domain: { name: DOMAIN },
      compatibility: { date: "2026-05-08", flags: ["nodejs_compat"] },
      env: {
        AgentObject: Cloudflare.DurableObject<AgentObject>("AgentObject"),
        Hub: Cloudflare.DurableObject<Hub>("Hub"),
        WebChat: Cloudflare.DurableObject<WebChatObject>("WebChatObject", {
          className: "WebChatObject",
        }),
        Automations: Cloudflare.DurableObject<AutomationsObject>("Automations", {
          className: "AutomationsObject",
        }),
        Files: files,
        AI: Cloudflare.Workers.AI(),
        BROWSER: Cloudflare.Workers.Browser(),
        PUBLIC_URL: `https://${DOMAIN}`,
        ACCESS_TEAM_DOMAIN: accessTeamDomain,
        ACCESS_AUD: dashboardAccessApplication.aud,
        CHAT_ACCESS_AUD: chatAccessApplication.aud,

        BOT_TOKEN: Config.Redacted("BOT_TOKEN"),
        MIZOOK_WEBHOOK_SECRET: Config.Redacted("MIZOOK_WEBHOOK_SECRET"),
        DEEPSEEK_API_KEY: Config.Redacted("DEEPSEEK_API_KEY"),

        TELEGRAM_ALLOWED_USER_IDS: Config.String("TELEGRAM_ALLOWED_USER_IDS"),
        BOT_USERNAME: emptyMeansDefault("BOT_USERNAME"),
        AGENT_NAME: emptyMeansDefault("AGENT_NAME"),
        INSTRUCTIONS: emptyMeansDefault("INSTRUCTIONS"),
        MODEL: emptyMeansDefault("MODEL"),
        SUMMARY_MODEL: emptyMeansDefault("SUMMARY_MODEL"),
        TIMEZONE: emptyMeansDefault("TIMEZONE"),
        BUDGET_DAILY: emptyMeansDefault("BUDGET_DAILY"),
        SEARCH_PROVIDERS: emptyMeansDefault("SEARCH_PROVIDERS"),
        PARALLEL_API_KEY: optionalSecret("PARALLEL_API_KEY"),
        EXECUTOR_URL: emptyMeansDefault("EXECUTOR_URL"),
        EXECUTOR_TOKEN: optionalSecret("EXECUTOR_TOKEN"),
        EXA_API_KEY: optionalSecret("EXA_API_KEY"),
      },
    });

    return { url: worker.url };
  }),
);
