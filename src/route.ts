interface TelegramMessage {
  readonly chat?: { readonly id?: number };
  readonly message_thread_id?: number;
}

interface TelegramUpdate {
  readonly message?: TelegramMessage;
  readonly edited_message?: TelegramMessage;
  readonly channel_post?: TelegramMessage;
  readonly callback_query?: { readonly message?: TelegramMessage };
  readonly message_reaction?: TelegramMessage;
}

/**
 * The name of the Durable Object that owns the chat an update belongs to: one per forum topic
 * (`chatId:topicId`), one per group's General topic or DM (`chatId`). An update that names no
 * chat goes to `main`.
 */
export const channelOf = (update: unknown): string => {
  const u = (update ?? {}) as TelegramUpdate;
  const message =
    u.message ??
    u.edited_message ??
    u.channel_post ??
    u.callback_query?.message ??
    u.message_reaction;
  const chatId = message?.chat?.id;
  if (chatId === undefined) return "main";
  const topic = message?.message_thread_id;
  return typeof topic === "number" ? `${chatId}:${topic}` : String(chatId);
};
