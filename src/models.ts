import type { Model, Api } from "@earendil-works/pi-ai";
import { createModels, type Models as PiModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { Context, Effect, Layer, Redacted } from "effect";
import { Settings } from "./config.ts";
import { ModelNotFound } from "./errors.ts";

export class Models extends Context.Service<
  Models,
  {
    /** pi-ai's model collection, with auth from our settings instead of `process.env`. */
    readonly models: PiModels;
    readonly main: Model<Api>;
    readonly summary: Model<Api>;
  }
>()("mizook/Models") {
  static readonly layer = Layer.effect(
    Models,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const env: Record<string, string> = { DEEPSEEK_API_KEY: Redacted.value(settings.apiKey) };
      const models = createModels({
        authContext: { env: async (name) => env[name], fileExists: async () => false },
      });
      models.setProvider(deepseekProvider());

      const find = (id: string) => {
        const model = models.getModel("deepseek", id);
        return model
          ? Effect.succeed(model)
          : Effect.fail(new ModelNotFound({ provider: "deepseek", model: id }));
      };
      const [main, summary] = yield* Effect.all([
        find(settings.model),
        find(settings.summaryModel),
      ]);
      return Models.of({ models, main, summary });
    }),
  );
}
