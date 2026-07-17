import { Effect } from "effect";
import { createTelegramAdapter, type TelegramAdapter } from "@chat-adapter/telegram";
import type { Channel } from "../../core/channel";
import { ChatActionError } from "../../core/errors";

export function createTelegramChannel(botToken: string): Channel {
  const tg = createTelegramAdapter({ botToken }) as TelegramAdapter;

  return {
    adapter: tg,
    decodeThreadId: (threadId) => tg.decodeThreadId(threadId),
    postNotification: (target, message) =>
      Effect.tryPromise({
        try: () =>
          tg.postMessage(tg.encodeThreadId({ chatId: target.chatId }), message),
        catch: (cause) => new ChatActionError({ cause }),
      }),
    postPhoto: (target, photo, caption) =>
      Effect.tryPromise({
        try: async () => {
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
        },
        catch: (cause) => new ChatActionError({ cause }),
      }),
  };
}
