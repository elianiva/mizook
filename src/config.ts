import { Config, Context, Effect, Layer, Redacted } from "effect";

const withDefault = <A>(config: Config.Config<A>, value: A) =>
  config.pipe(Config.withDefault(value));

const NOBODY_ALLOWED = "";
const NO_DAILY_BUDGET_LIMIT = 0;

export const AppConfig = Config.all({
  botToken: Config.Redacted("BOT_TOKEN"),
  webhookSecret: Config.Redacted("MIZOOK_WEBHOOK_SECRET"),
  apiKey: Config.Redacted("DEEPSEEK_API_KEY"),
  allowedUserIds: withDefault(Config.String("TELEGRAM_ALLOWED_USER_IDS"), NOBODY_ALLOWED),
  botUsername: withDefault(Config.String("BOT_USERNAME"), "mizook"),
  agentName: withDefault(Config.String("AGENT_NAME"), "Mizook"),
  instructions: withDefault(Config.String("INSTRUCTIONS"), ""),
  model: withDefault(Config.String("MODEL"), "deepseek-flash"),
  summaryModel: withDefault(Config.String("SUMMARY_MODEL"), "deepseek-flash"),
  timezone: withDefault(Config.String("TIMEZONE"), "Asia/Jakarta"),
  publicUrl: withDefault(Config.String("PUBLIC_URL"), ""),
  budgetDaily: withDefault(Config.Number("BUDGET_DAILY"), NO_DAILY_BUDGET_LIMIT),
  executorUrl: withDefault(Config.String("EXECUTOR_URL"), ""),
  executorToken: withDefault(Config.Redacted("EXECUTOR_TOKEN"), Redacted.make("")),
  searchProviders: withDefault(Config.String("SEARCH_PROVIDERS"), "parallel,exa"),
  parallelKey: withDefault(Config.Redacted("PARALLEL_API_KEY"), Redacted.make("")),
  exaKey: withDefault(Config.Redacted("EXA_API_KEY"), Redacted.make("")),
});

export class Settings extends Context.Service<
  Settings,
  {
    readonly botToken: Redacted.Redacted<string>;
    readonly webhookSecret: Redacted.Redacted<string>;
    readonly apiKey: Redacted.Redacted<string>;
    readonly allowedUserIds: ReadonlySet<string>;
    readonly botUsername: string;
    readonly agentName: string;
    readonly instructions: string;
    readonly model: string;
    readonly summaryModel: string;
    readonly timezone: string;
    readonly publicUrl: string;
    readonly budgetDaily: number;
    readonly executorUrl: string;
    readonly executorToken: Redacted.Redacted<string>;
    readonly searchProviders: ReadonlyArray<string>;
    readonly searchKeys: Readonly<Record<string, Redacted.Redacted<string>>>;
  }
>()("mizook/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const allowedUserIds = new Set(
        config.allowedUserIds
          .split(/[\s,]+/)
          .map((id) => id.trim())
          .filter(Boolean),
      );
      return Settings.of({
        ...config,
        allowedUserIds,
        searchProviders: config.searchProviders
          .split(/[\s,]+/)
          .map((name) => name.trim())
          .filter(Boolean),
        searchKeys: { parallel: config.parallelKey, exa: config.exaKey },
      });
    }),
  );
}
