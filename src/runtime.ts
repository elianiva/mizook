import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { Memory } from "@mizook/memory";
import { sqliteStore, type SqlDriver } from "@mizook/memory/sqlite";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect";
import { Agent } from "./agent.ts";
import { Bot } from "./bot.ts";
import { Settings } from "./config.ts";
import { Durable } from "./durable.ts";
import type { Env } from "./env.ts";
import { formatDate } from "./format.ts";
import { Models } from "./models.ts";
import { State } from "./state.ts";
import { Handlers } from "./handlers.ts";
import { Artifacts } from "./artifacts.ts";
import { Blobs } from "./blobs.ts";
import { Web } from "./search.ts";
import { Schedules } from "./schedules.ts";
import { SummarizerLive } from "./summarizer.ts";
import { TOOL_GUIDE } from "./tools.ts";

/**
 * Everything the Durable Object runs, as one layer over its own storage.
 *
 * pi-durable and the memory share one SQLite connection. pi-durable keeps its operations in a
 * queue so a transaction excludes everything else; the memory and the bot's state go through the
 * same database object, so none of their writes can land inside one of its transactions.
 */
export const makeRuntime = (storage: DurableObjectStorage, env: Env) => {
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
  const settings = Settings.layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(vars))),
  );
  const models = Models.layer.pipe(Layer.provideMerge(settings));
  const memory = Layer.unwrap(
    Effect.gen(function* () {
      const { agentName, instructions, timezone } = yield* Settings;
      return Memory.layer({
        name: agentName,
        instructions: instructions === "" ? TOOL_GUIDE : `${TOOL_GUIDE}\n\n${instructions}`,
        formatDate: (date) => formatDate(date, timezone),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(sqliteStore(sql), SummarizerLive)), Layer.provideMerge(models));

  const app = Bot.layer.pipe(
    Layer.provideMerge(Agent.layer),
    Layer.provideMerge(Durable.layer(database)),
    Layer.provideMerge(Handlers.layer),
    Layer.provideMerge(Artifacts.layer(sql)),
    Layer.provideMerge(Blobs.r2(env.Files)),
    Layer.provideMerge(Web.layer),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Schedules.layer(sql, arm)),
    Layer.provideMerge(State.layer(sql)),
    Layer.provideMerge(memory),
  );
  return ManagedRuntime.make(app);
};

export type AppRuntime = ReturnType<typeof makeRuntime>;
