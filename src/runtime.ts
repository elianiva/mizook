import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { Memory } from "@mizook/memory";
import { sqliteStore } from "@mizook/memory/sqlite";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect";
import { Agent } from "./agent.ts";
import { Bot } from "./bot.ts";
import { Browser } from "./browser.ts";
import { Settings } from "./config.ts";
import { Durable } from "./durable.ts";
import type { Env } from "./env.ts";
import { formatDate } from "./format.ts";
import { Models } from "./models.ts";
import {
  Agents,
  AutomationsClient,
  GlobalSkills,
  ProfileStore,
  Self,
  type AgentInfo,
} from "./host.ts";
import { Media } from "./media.ts";
import { Intents } from "./intents.ts";
import { Policies } from "./policies.ts";
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
import { WebThreads } from "./chat/threads.ts";
import { WebChatClient } from "./chat/web-chat-client.ts";
import { Skills } from "./skills.ts";
import { Sql, type SqlDriver } from "./sql.ts";
import { SummarizerLive } from "./summarizer.ts";
import { PERSONA } from "./persona.ts";
import { TOOL_GUIDE } from "./tools.ts";
import { catalogText } from "./codemode.ts";

/** What the AgentObject gives its runtime, one capability per service. */
export interface Capabilities {
  readonly self: AgentInfo;
  readonly agents: Agents["Service"];
  readonly profile: ProfileStore["Service"];
  readonly globalSkills: GlobalSkills["Service"];
  readonly automations: AutomationsClient["Service"];
}

export const makeRuntime = (storage: DurableObjectStorage, env: Env, host: Capabilities) => {
  const sharedDatabase = new DurableObjectSqliteDatabase(storage);
  const sql: SqlDriver = {
    all: <T>(query: string, ...params: unknown[]) =>
      sharedDatabase.all(query, ...(params as never[])) as Promise<T[]>,
  };
  const sqlLayer = Sql.layer(sql);
  const usage = Usage.layer.pipe(Layer.provideMerge(sqlLayer));

  const varsSet = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const fromEnv = Settings.layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(varsSet))),
  );
  const settings = Layer.effect(
    Settings,
    Effect.gen(function* () {
      const base = yield* Settings;
      const own = yield* readSettings;
      const budget = Number(own.budget);
      return Settings.of({
        ...base,
        ...(own.instructions !== undefined && { instructions: own.instructions }),
        ...(own.model !== undefined && { model: own.model }),
        ...(own.timezone !== undefined && { timezone: own.timezone }),
        ...(own.budget !== undefined && Number.isFinite(budget) && { budgetDaily: budget }),
      });
    }).pipe(Effect.provide(fromEnv)),
  ).pipe(Layer.provide(sqlLayer));
  const models = Models.layer.pipe(Layer.provideMerge(settings));
  const memory = Layer.unwrap(
    Effect.gen(function* () {
      const { instructions: userInstructionsLast, timezone } = yield* Settings;
      const howItTalks = host.self.persona.trim() || PERSONA;
      const whatItIsFor =
        host.self.role.trim() === "" ? "" : `# Your role\n\n${host.self.role.trim()}`;
      return Memory.layer({
        name: host.self.name,
        instructions: [
          howItTalks,
          TOOL_GUIDE,
          `# Tools\n\n${catalogText(host.self.tools)}`,
          whatItIsFor,
          userInstructionsLast,
        ]
          .filter((part) => part !== "")
          .join("\n\n"),
        formatDate: (date) => formatDate(date, timezone),
      });
    }),
  ).pipe(
    Layer.provide(Layer.merge(sqliteStore(sql), SummarizerLive.pipe(Layer.provide(usage)))),
    Layer.provideMerge(models),
  );

  const hostLayer = Layer.mergeAll(
    Layer.succeed(Self, host.self),
    Layer.succeed(Agents, host.agents),
    Layer.succeed(ProfileStore, host.profile),
    Layer.succeed(GlobalSkills, host.globalSkills),
    Layer.succeed(AutomationsClient, host.automations),
  );

  const app = Bot.layer.pipe(
    Layer.provideMerge(Commands.layer),
    Layer.provideMerge(Agent.layer),
    Layer.provideMerge(Durable.layer(sharedDatabase)),
    Layer.provideMerge(Handlers.layer),
    Layer.provideMerge(Outbox.layer),
    Layer.provideMerge(Executor.layer),
    Layer.provideMerge(Approvals.layer),
    Layer.provideMerge(Backup.layer),
    Layer.provideMerge(hostLayer),
    Layer.provideMerge(Layer.merge(WebChatClient.layer(env), WebThreads.layer)),
    Layer.provideMerge(Artifacts.layer),
    Layer.provideMerge(
      Layer.merge(
        Layer.merge(Blobs.r2(env.Files), Media.layer(env.AI)),
        Browser.layer(env.BROWSER),
      ),
    ),
    Layer.provideMerge(Web.layer),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Layer.merge(Intents.layer, Policies.layer)),
    Layer.provideMerge(Skills.layer),
    Layer.provideMerge(State.layer),
    Layer.provideMerge(sqliteStore(sql)),
    Layer.provideMerge(memory),
    Layer.provideMerge(usage),
  );
  return ManagedRuntime.make(app);
};

export type AppRuntime = ReturnType<typeof makeRuntime>;
