import { Effect, Schema } from "effect";

const Message = Schema.Struct({
  message_id: Schema.optionalKey(Schema.Finite),
  chat: Schema.optionalKey(Schema.Struct({ id: Schema.Finite })),
  message_thread_id: Schema.optionalKey(Schema.Finite),
  is_topic_message: Schema.optionalKey(Schema.Boolean),
  text: Schema.optionalKey(Schema.String),
  caption: Schema.optionalKey(Schema.String),
});

/** The parts of a Telegram update that say where it was said and whom it is for. */
const Update = Schema.Struct({
  message: Schema.optionalKey(Message),
  edited_message: Schema.optionalKey(Message),
  channel_post: Schema.optionalKey(Message),
  callback_query: Schema.optionalKey(
    Schema.Struct({
      message: Schema.optionalKey(Message),
      data: Schema.optionalKey(Schema.String),
    }),
  ),
  message_reaction: Schema.optionalKey(Message),
});

const decodeUpdate = Schema.decodeUnknownEffect(Schema.fromJsonString(Update));

export interface Routing {
  /** Where the update was said: the Chat SDK thread id, `telegram:<chat>` or `telegram:<chat>:<topic>`. */
  readonly place: string;
  /** The command the message starts with, without its slash or `@bot`. */
  readonly command: string | undefined;
  /** The agent a button belongs to: approval buttons carry it, since any agent may post one anywhere. */
  readonly agentId: string | undefined;
}

/** The agent id inside a button's callback data, as `bot.ts` writes it: `<verb>:<agentId>:<n>`. */
const agentOfCallback = (data: string | undefined): string | undefined => {
  if (data === undefined) return undefined;
  let action = data;
  // The Chat SDK wraps an action id as `chat:{"a":"<id>"}`.
  if (data.startsWith("chat:")) {
    try {
      const decoded = JSON.parse(data.slice(5)) as { a?: unknown };
      if (typeof decoded.a === "string") action = decoded.a;
    } catch {
      return undefined;
    }
  }
  return /^(?:approve|always|deny):([a-z0-9]+):\d+$/.exec(action)?.[1];
};

/**
 * Where an update belongs, the same way the Chat SDK names threads: a forum topic is its own
 * place, and so is a group or a DM. An update that names no chat goes to `telegram:main`. Fails
 * when the body is not a Telegram update.
 */
export const routeOf = (body: string) =>
  decodeUpdate(body).pipe(
    Effect.map((u): Routing => {
      const message =
        u.message ??
        u.edited_message ??
        u.channel_post ??
        u.callback_query?.message ??
        u.message_reaction;
      const chatId = message?.chat?.id;
      const topic = message?.is_topic_message === true ? message.message_thread_id : undefined;
      const place =
        chatId === undefined
          ? "telegram:main"
          : topic === undefined
            ? `telegram:${chatId}`
            : `telegram:${chatId}:${topic}`;
      const said = u.message?.text ?? u.message?.caption;
      const command =
        said === undefined
          ? undefined
          : /^\/([a-z0-9_]+)(?:@\w+)?(?:\s|$)/i.exec(said)?.[1]?.toLowerCase();
      return { place, command, agentId: agentOfCallback(u.callback_query?.data) };
    }),
  );
