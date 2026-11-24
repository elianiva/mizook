import { Context, Effect, Layer } from "effect";
import { ToolError } from "./errors.ts";
import type { ModelTool, ToolServices } from "./tool.ts";
import { handledTools } from "./tools.ts";

type HandledServices = ToolServices<(typeof handledTools)[number]>;

export class Handlers extends Context.Service<
  Handlers,
  {
    call(name: string, args: unknown, place: string | undefined): Effect.Effect<string>;
    run(
      name: string,
      args: unknown,
      place: string | undefined,
    ): Effect.Effect<string, { readonly message: string }>;
  }
>()("mizook/Handlers") {
  static readonly layer = Layer.effect(
    Handlers,
    Effect.gen(function* () {
      const services = yield* Effect.context<HandledServices>();
      const byName = new Map<string, ModelTool<HandledServices>>(
        handledTools.map((tool) => [tool.name, tool]),
      );

      const run = (
        name: string,
        args: unknown,
        place: string | undefined,
      ): Effect.Effect<string, { readonly message: string }> => {
        const tool = byName.get(name);
        return tool === undefined
          ? Effect.fail(new ToolError({ reason: `no tool ${name}` }))
          : tool.run(args, place).pipe(Effect.provideContext(services));
      };

      const failureAsTextTheAgentCanActOn = (error: { readonly message: string }) =>
        Effect.succeed(`Error: ${error.message}`);
      return Handlers.of({
        run,
        call: (name, args, place) =>
          run(name, args, place).pipe(Effect.catch(failureAsTextTheAgentCanActOn)),
      });
    }),
  );
}
