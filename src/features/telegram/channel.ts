import { Context, Effect, Layer } from "effect";
import { createTelegramAdapter, type TelegramAdapter } from "@chat-adapter/telegram";
import { WorkersEnv } from "../../core/workers-env";
import type { Channel, ChatTarget } from "../../core/channel";

// Sole implementation; the TelegramChannel service wraps this.
export function createTelegramChannel(botToken: string): Channel {
  const tg = createTelegramAdapter({ botToken }) as TelegramAdapter;

  return {
    name: "telegram",
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

export class TelegramChannel extends Context.Service<TelegramChannel, Channel>()(
  "mizook/TelegramChannel",
) {
  static readonly layer = Layer.effect(TelegramChannel)(
    Effect.gen(function* () {
      const { env } = yield* WorkersEnv;
      return TelegramChannel.of(createTelegramChannel(env.BOT_TOKEN));
    }),
  );
}

export type { ChatTarget };
