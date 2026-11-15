import { Config, Context, Effect, Layer, Redacted } from "effect";

const withDefault = <A>(config: Config.Config<A>, value: A) =>
  config.pipe(Config.withDefault(value));

/** Everything the bot reads from its environment: secrets, who may use it, and which models run. */
export const AppConfig = Config.all({
  botToken: Config.Redacted("BOT_TOKEN"),
  webhookSecret: Config.Redacted("MIZOOK_WEBHOOK_SECRET"),
  apiKey: Config.Redacted("DEEPSEEK_API_KEY"),
  /** Comma-separated Telegram user ids. Nobody may use the bot until this is set. */
  allowedUserIds: withDefault(Config.String("TELEGRAM_ALLOWED_USER_IDS"), ""),
  botUsername: withDefault(Config.String("BOT_USERNAME"), "mizook"),
  /** The agent's name, as it knows itself. */
  agentName: withDefault(Config.String("AGENT_NAME"), "Mizook"),
  /** The user's own instructions: who they are and how they want work done. */
  instructions: withDefault(Config.String("INSTRUCTIONS"), ""),
  model: withDefault(Config.String("MODEL"), "deepseek-flash"),
  /** The cheap model that writes the memory. */
  summaryModel: withDefault(Config.String("SUMMARY_MODEL"), "deepseek-flash"),
  timezone: withDefault(Config.String("TIMEZONE"), "Asia/Jakarta"),
  /** Search backends, in the order they are tried. */
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
    readonly searchProviders: ReadonlyArray<string>;
    /** The API key of each search provider, by name. */
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
