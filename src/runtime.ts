import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { Memory } from "@mizook/memory";
import { sqliteStore, type SqlDriver } from "@mizook/memory/sqlite";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ConfigProvider, type Context, Effect, Layer, ManagedRuntime } from "effect";
import { Agent } from "./agent.ts";
import { Bot } from "./bot.ts";
import { Browser } from "./browser.ts";
import { Settings } from "./config.ts";
import { Durable } from "./durable.ts";
import type { Env } from "./env.ts";
import { formatDate } from "./format.ts";
import { Models } from "./models.ts";
import { Host } from "./host.ts";
import { Media } from "./media.ts";
import { Intents } from "./intents.ts";
import { Policies } from "./policies.ts";
import { Runs } from "./runs.ts";
import { Usage } from "./usage.ts";
import { readSettings, State } from "./state.ts";
import { Executor } from "./executor.ts";
import { Outbox } from "./outbox.ts";
import { Handlers } from "./handlers.ts";
import { Approvals } from "./approvals.ts";
import { Artifacts } from "./artifacts.ts";
import { Commands } from "./commands.ts";
import { Backup } from "./backup.ts";
import { Blobs } from "./blobs.ts";
import { Web } from "./search.ts";
import { Schedules } from "./schedules.ts";
import { Skills } from "./skills.ts";
import { SummarizerLive } from "./summarizer.ts";
import { PERSONA } from "./persona.ts";
import { TOOL_GUIDE } from "./tools.ts";

/**
 * Everything the Durable Object runs, as one layer over its own storage.
 *
 * pi-durable and the memory share one SQLite connection. pi-durable keeps its operations in a
 * queue so a transaction excludes everything else; the memory and the bot's state go through the
 * same database object, so none of their writes can land inside one of its transactions.
 */
export const makeRuntime = (
  storage: DurableObjectStorage,
  env: Env,
  host: Context.Service.Shape<typeof Host>,
) => {
  /** Move the alarm earlier, never later. */
  const arm = async (at: number) => {
    const current = await storage.getAlarm();
    if (current === null || at < current) await storage.setAlarm(at);
  };
  const database = new DurableObjectSqliteDatabase(storage);
  const sql: SqlDriver = {
    all: <T>(query: string, ...params: unknown[]) =>
      database.all(query, ...(params as never[])) as Promise<T[]>,
  };

  // A variable left empty in the stack means "use the default".
  const vars = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const fromEnv = Settings.layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(vars))),
  );
  // The channel's own settings (`/model`, `/instructions`, …) win over the environment.
  const settings = Layer.effect(
    Settings,
    Effect.gen(function* () {
      const base = yield* Settings;
      const own = yield* readSettings(sql);
      const budget = Number(own.budget);
      return Settings.of({
        ...base,
        ...(own.instructions !== undefined && { instructions: own.instructions }),
        ...(own.model !== undefined && { model: own.model }),
        ...(own.timezone !== undefined && { timezone: own.timezone }),
        ...(own.budget !== undefined && Number.isFinite(budget) && { budgetDaily: budget }),
      });
    }).pipe(Effect.provide(fromEnv)),
  );
  const models = Models.layer.pipe(Layer.provideMerge(settings));
  const memory = Layer.unwrap(
    Effect.gen(function* () {
      const { agentName, instructions, timezone } = yield* Settings;
      return Memory.layer({
        name: agentName,
        instructions: [PERSONA, TOOL_GUIDE, instructions]
          .filter((part) => part !== "")
          .join("\n\n"),
        formatDate: (date) => formatDate(date, timezone),
      });
    }),
  ).pipe(
    Layer.provide(
      Layer.merge(sqliteStore(sql), SummarizerLive.pipe(Layer.provide(Usage.layer(sql)))),
    ),
    Layer.provideMerge(models),
  );

  const app = Bot.layer.pipe(
    Layer.provideMerge(Commands.layer),
    Layer.provideMerge(Agent.layer),
    Layer.provideMerge(Durable.layer(database)),
    Layer.provideMerge(Handlers.layer),
    Layer.provideMerge(Outbox.layer),
    Layer.provideMerge(Executor.layer),
    Layer.provideMerge(Approvals.layer(sql)),
    Layer.provideMerge(Backup.layer),
    Layer.provideMerge(Usage.layer(sql)),
    Layer.provideMerge(Layer.succeed(Host, host)),
    Layer.provideMerge(Artifacts.layer(sql)),
    Layer.provideMerge(
      Layer.merge(
        Layer.merge(Blobs.r2(env.Files), Media.layer(env.AI)),
        Browser.layer(env.BROWSER),
      ),
    ),
    Layer.provideMerge(Web.layer),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Layer.merge(Schedules.layer(sql, arm), Runs.layer(sql))),
    Layer.provideMerge(Layer.merge(Intents.layer(sql), Policies.layer(sql))),
    Layer.provideMerge(Skills.layer(sql)),
    Layer.provideMerge(State.layer(sql)),
    Layer.provideMerge(sqliteStore(sql)),
    Layer.provideMerge(memory),
  );
  return ManagedRuntime.make(app);
};

export type AppRuntime = ReturnType<typeof makeRuntime>;
