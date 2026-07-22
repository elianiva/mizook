import { Context, Data, Effect, Layer } from "effect";

import type { ToolDefinition } from "./types";

export class ToolNotFoundError extends Data.TaggedError("ToolNotFoundError")<{
  readonly name: string;
}> {}

export class ToolRegistryService extends Context.Service<
  ToolRegistryService,
  {
    readonly register: (def: ToolDefinition) => Effect.Effect<void>;
    readonly registerAll: (defs: ReadonlyArray<ToolDefinition>) => Effect.Effect<void>;
    readonly list: () => Effect.Effect<ReadonlyArray<ToolDefinition>>;
    readonly get: (name: string) => Effect.Effect<ToolDefinition, ToolNotFoundError>;
  }
>()("mizook/ToolRegistryService") {
  static readonly live = Layer.effect(
    ToolRegistryService,
    Effect.sync(() => {
      const store = new Map<string, ToolDefinition>();

      const register = (def: ToolDefinition) =>
        Effect.sync(() => {
          store.set(def.name, def);
        });

      const registerAll = (defs: ReadonlyArray<ToolDefinition>) =>
        Effect.sync(() => {
          for (const def of defs) {
            store.set(def.name, def);
          }
        });

      const list = () => Effect.sync(() => [...store.values()]);

      const get = (name: string) =>
        Effect.sync(() => {
          const def = store.get(name);
          return def ? Effect.succeed(def) : Effect.fail(new ToolNotFoundError({ name }));
        }).pipe(Effect.flatten);

      return ToolRegistryService.of({ register, registerAll, list, get });
    }),
  );
}
