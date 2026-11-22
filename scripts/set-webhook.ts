import { callTelegram } from "./telegram.ts";

const [workerUrl] = process.argv.slice(2);
const token = process.env.BOT_TOKEN;
const secret = process.env.MIZOOK_WEBHOOK_SECRET;

if (!workerUrl || !token || !secret) {
  console.error(
    "usage: BOT_TOKEN=… MIZOOK_WEBHOOK_SECRET=… node scripts/set-webhook.ts <worker url>",
  );
  process.exit(1);
}

const webhookUrl = `${workerUrl.replace(/\/$/, "")}/telegram/webhook`;

const mustCall = async (method: string, body: unknown) => {
  const result = await callTelegram(token, method, body);
  if (!result.ok) {
    console.error(`${method} failed: ${result.description ?? "unknown error"}`);
    process.exit(1);
  }
  return result;
};

try {
  await mustCall("setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  });
  console.log(`webhook set: ${webhookUrl}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
