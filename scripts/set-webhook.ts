import { Config, Data, Effect, Option } from "effect";

import { callTelegramEffect } from "./telegram.ts";

class WebhookError extends Data.TaggedError("WebhookError")<{ readonly reason: string }> {
  override get message(): string {
    return this.reason;
  }
}

const USAGE = "usage: BOT_TOKEN=… MIZOOK_WEBHOOK_SECRET=… node scripts/set-webhook.ts <worker url>";

const program = Effect.gen(function* () {
  const workerUrl = Option.fromNullishOr(process.argv[2]).pipe(
    Option.filter((value) => value !== ""),
  );
  const token = yield* Config.String("BOT_TOKEN").pipe(Config.option);
  const secret = yield* Config.String("MIZOOK_WEBHOOK_SECRET").pipe(Config.option);
  if (Option.isNone(workerUrl) || Option.isNone(token) || Option.isNone(secret)) {
    return yield* new WebhookError({ reason: USAGE });
  }
  const webhookUrl = `${workerUrl.value.replace(/\/$/, "")}/telegram/webhook`;
  const result = yield* callTelegramEffect(token.value, "setWebhook", {
    url: webhookUrl,
    secret_token: secret.value,
    allowed_updates: ["message", "callback_query"],
  });
  if (!result.ok) {
    return yield* new WebhookError({
      reason: `setWebhook failed: ${result.description ?? "unknown error"}`,
    });
  }
  yield* Effect.log(`webhook set: ${webhookUrl}`);
}).pipe(
  Effect.catch((error) =>
    Effect.sync(() => {
      console.error(error.message);
      process.exitCode = 1;
    }),
  ),
);

await Effect.runPromise(program);
