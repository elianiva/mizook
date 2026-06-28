import { Context, Layer } from "effect";
import type { Env } from "./env";

// `env` is the Cloudflare Worker bindings object (secrets, DO namespaces,
// Fetchers, R2 buckets), not a process.env-style flat map. We carry it as a
// service so other layers read bindings off a single provided value rather
// than threading `env: Env` through every function signature.
export class WorkersEnv extends Context.Service<
  WorkersEnv,
  {
    readonly env: Env;
  }
>()("mizook/WorkersEnv") {
  static readonly make = (env: Env): Layer.Layer<WorkersEnv> => Layer.succeed(WorkersEnv)({ env });
}
