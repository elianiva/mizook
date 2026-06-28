import { Layer, Logger, ManagedRuntime } from "effect";
import type { Env } from "./env";
import { WorkersEnv } from "./workers-env";
import { AllowedUsers } from "./allowed-users";
import { ChannelRegistry } from "./channel-registry";
import { Model } from "./model";
import { AgentGateway } from "./agent-gateway";
import { TelegramChannel } from "../features/telegram/channel";

// Deps shared across the app. The Chat/`Bot` factory (below) consumes this
// runtime Hono-style so imperative handler callbacks can `runtime.runPromise`
// into the same logger/services as everything else. The CF `env` bindings
// object is stable per warm isolate, so memo on its identity.
const buildLayer = (env: Env) => {
  // core = logger + Worker binding, no remaining requirements.
  const core = Layer.mergeAll(Logger.layer([Logger.consoleJson]), WorkersEnv.make(env));
  // env-dependent singletons, each satisfied by core.
  const telegram = TelegramChannel.layer.pipe(Layer.provide(core));
  const registry = ChannelRegistry.layer.pipe(Layer.provide(telegram));
  const allowed = AllowedUsers.layer.pipe(Layer.provide(core));
  const model = Model.layer.pipe(Layer.provide(core));
  const gateway = AgentGateway.layer.pipe(Layer.provide(core));
  return Layer.mergeAll(core, telegram, registry, allowed, model, gateway);
};

export type AppServices =
  | WorkersEnv
  | AllowedUsers
  | ChannelRegistry
  | Model
  | AgentGateway
  | typeof TelegramChannel;

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

const memoMap = Layer.makeMemoMapUnsafe();

let cached: { readonly env: Env; readonly runtime: AppRuntime } | null = null;

export function getRuntime(env: Env): AppRuntime {
  if (cached !== null && cached.env === env) return cached.runtime;
  const runtime = ManagedRuntime.make(buildLayer(env), { memoMap });
  cached = { env, runtime };
  return runtime;
}
