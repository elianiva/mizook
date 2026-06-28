import { Effect } from "effect";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { TelegramAdapter } from "@chat-adapter/telegram";
import type { ChannelInterface } from "../../core/channel";

export function createTelegramChannel(botToken: string): ChannelInterface {
  const tg = createTelegramAdapter({ botToken }) as TelegramAdapter;

  return {
    adapter: tg,
    postNotification: (target, message) =>
      Effect.tryPromise(() =>
        tg.postMessage(tg.encodeThreadId({ chatId: target.chatId }), message),
      ),
    postPhoto: (target, photo, caption) =>
      Effect.tryPromise(async () => {
        const form = new FormData();
        form.append("chat_id", target.chatId);
        form.append("photo", new Blob([photo as BlobPart], { type: "image/png" }), "screenshot.png");
        form.append("caption", caption.slice(0, 200));
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) throw new Error(`sendPhoto failed: ${res.status}`);
      }),
  };
}
