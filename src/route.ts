import { Effect, Schema } from "effect";

const Message = Schema.Struct({
  chat: Schema.optionalKey(Schema.Struct({ id: Schema.Finite })),
  message_thread_id: Schema.optionalKey(Schema.Finite),
});

/** The parts of a Telegram update that say which chat and topic it belongs to. */
const Update = Schema.Struct({
  message: Schema.optionalKey(Message),
  edited_message: Schema.optionalKey(Message),
  channel_post: Schema.optionalKey(Message),
  callback_query: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Message) })),
  message_reaction: Schema.optionalKey(Message),
});

const decodeUpdate = Schema.decodeUnknownEffect(Schema.fromJsonString(Update));

/**
 * The name of the Durable Object that owns the chat an update belongs to: one per forum topic
 * (`chatId:topicId`), one per group's General topic or DM (`chatId`). An update that names no
 * chat goes to `main`. Fails when the body is not a Telegram update.
 */
export const channelOf = (body: string) =>
  decodeUpdate(body).pipe(
    Effect.map((u) => {
      const message =
        u.message ??
        u.edited_message ??
        u.channel_post ??
        u.callback_query?.message ??
        u.message_reaction;
      const chatId = message?.chat?.id;
      if (chatId === undefined) return "main";
      const topic = message?.message_thread_id;
      return topic === undefined ? String(chatId) : `${chatId}:${topic}`;
    }),
  );
