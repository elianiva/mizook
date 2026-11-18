/**
 * Point the Telegram bot at the deployed Worker, and publish its command menu.
 *
 *     pnpm webhook https://mizook-….workers.dev
 *
 * Reads BOT_TOKEN and MIZOOK_WEBHOOK_SECRET from `.env`. The secret is sent back by Telegram on
 * every update, and the Worker turns away anything without it.
 */
import { COMMANDS } from "../src/command-list.ts";
import { callTelegram } from "./telegram.ts";

const [base] = process.argv.slice(2);
const token = process.env.BOT_TOKEN;
const secret = process.env.MIZOOK_WEBHOOK_SECRET;

if (!base || !token || !secret) {
  console.error(
    "usage: BOT_TOKEN=… MIZOOK_WEBHOOK_SECRET=… node scripts/set-webhook.ts <worker url>",
  );
  process.exit(1);
}

const url = `${base.replace(/\/$/, "")}/telegram/webhook`;

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
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  });
  console.log(`webhook set: ${url}`);

  // The menu next to the text box is the same list `/help` prints.
  await mustCall("setMyCommands", { commands: COMMANDS });
  console.log(`menu set: ${COMMANDS.length} commands`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
