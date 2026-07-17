import { Effect } from "effect";
import { createTelegramAdapter, type TelegramAdapter } from "@chat-adapter/telegram";
import { commands } from "../../core/bot";
import type { Channel } from "../../core/channel";

export function createTelegramChannel(botToken: string): Channel {
  const tg = createTelegramAdapter({ botToken }) as TelegramAdapter;

  return {
    adapter: tg,
    decodeThreadId: (threadId) => tg.decodeThreadId(threadId),
    postNotification: (target, message) =>
      Effect.tryPromise(() =>
        tg.postMessage(tg.encodeThreadId({ chatId: target.chatId }), message),
      ),
    postPhoto: (target, photo, caption) =>
      Effect.tryPromise(async () => {
        const form = new FormData();
        form.append("chat_id", target.chatId);
        form.append(
          "photo",
          new Blob([photo as BlobPart], { type: "image/png" }),
          "screenshot.png",
        );
        form.append("caption", caption.slice(0, 200));
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) throw new Error(`sendPhoto failed: ${res.status}`);
      }),
  };
}

export async function syncCommandMenu(botToken: string): Promise<void> {
  const menuCommands = commands
    .filter((c) => c.slash)
    .map((c) => ({ command: c.name, description: c.description }));
  const res = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: menuCommands }),
  });
  if (!res.ok) throw new Error(`setMyCommands failed: ${res.status}`);
}
