/**
 * Point the Telegram bot at the deployed Worker, and publish its command menu.
 *
 *     pnpm webhook https://mizook-….workers.dev
 *
 * Reads BOT_TOKEN and MIZOOK_WEBHOOK_SECRET from `.env`. The secret is sent back by Telegram on
 * every update, and the Worker turns away anything without it.
 */
import { COMMANDS } from "../src/command-list.ts";

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
const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  }),
});
const result = (await response.json()) as { ok: boolean; description?: string };
if (!result.ok) {
  console.error(`setWebhook failed: ${result.description ?? response.status}`);
  process.exit(1);
}
console.log(`webhook set: ${url}`);

// The menu next to the text box is the same list `/help` prints.
const menu = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ commands: COMMANDS }),
});
const menuResult = (await menu.json()) as { ok: boolean; description?: string };
if (!menuResult.ok) {
  console.error(`setMyCommands failed: ${menuResult.description ?? menu.status}`);
  process.exit(1);
}
console.log(`menu set: ${COMMANDS.length} commands`);
