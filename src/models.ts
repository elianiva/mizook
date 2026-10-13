import type { Model, Api } from "@earendil-works/pi-ai";
import { createModels, type Models as PiModels } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
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
      const env: Record<string, string> = { OPENCODE_API_KEY: Redacted.value(settings.apiKey) };
      const models = createModels({
        authContext: { env: async (name) => env[name], fileExists: async () => false },
      });
      models.setProvider(opencodeGoProvider());

      const find = (id: string) => {
        const model = models.getModel(settings.provider, id);
        return model
          ? Effect.succeed(model)
          : Effect.fail(new ModelNotFound({ provider: settings.provider, model: id }));
      };
      const [main, summary] = yield* Effect.all([
        find(settings.model),
        find(settings.summaryModel),
      ]);
      return Models.of({ models, main, summary });
    }),
  );
}
