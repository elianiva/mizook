import { Layer, Logger, ManagedRuntime } from "effect";
import type { Env } from "./env";
import { WorkersEnv } from "./workers-env";

// Chat/`Bot` factory consumes this runtime so imperative handler callbacks
// can `runtime.runPromise` into the same services. CF `env` bindings are
// stable per warm isolate, so memo on its identity.
const buildLayer = (env: Env) => {
  return Layer.mergeAll(Logger.layer([Logger.consoleJson]), WorkersEnv.make(env));
};

export type AppServices = WorkersEnv;

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

const memoMap = Layer.makeMemoMapUnsafe();

let cached: { readonly env: Env; readonly runtime: AppRuntime } | null = null;

export function getRuntime(env: Env): AppRuntime {
  if (cached !== null && cached.env === env) return cached.runtime;
  const runtime = ManagedRuntime.make(buildLayer(env), { memoMap });
  cached = { env, runtime };
  return runtime;
}
