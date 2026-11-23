import { Effect, Option, Schema } from "effect";

const Message = Schema.Struct({
  message_id: Schema.optionalKey(Schema.Finite),
  chat: Schema.optionalKey(Schema.Struct({ id: Schema.Finite })),
  message_thread_id: Schema.optionalKey(Schema.Finite),
  is_topic_message: Schema.optionalKey(Schema.Boolean),
  text: Schema.optionalKey(Schema.String),
  caption: Schema.optionalKey(Schema.String),
});

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
  readonly place: string;
  readonly command: string | undefined;
  readonly agentId: string | undefined;
}

const CHAT_SDK_ACTION_PREFIX = "chat:";

const decodeCallbackAction = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ a: Schema.optional(Schema.Unknown) })),
);

const agentOfCallback = (data: string | undefined): string | undefined => {
  if (data === undefined) return undefined;
  let action = data;
  if (data.startsWith(CHAT_SDK_ACTION_PREFIX)) {
    const decoded = decodeCallbackAction(data.slice(CHAT_SDK_ACTION_PREFIX.length));
    if (Option.isNone(decoded)) return undefined;
    if (typeof decoded.value.a === "string") action = decoded.value.a;
  }
  return /^(?:approve|always|deny):([a-z0-9]+):\d+$/.exec(action)?.[1];
};

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
