import { Context, Effect, Layer, Schema } from "effect";
import type { Adapter } from "chat";
import type { Channel } from "./channel";
import { TelegramChannel } from "../features/telegram/channel";

export class UnknownChannelError extends Schema.TaggedErrorClass<UnknownChannelError>()(
  "UnknownChannelError",
  {
    channelName: Schema.String,
  },
) {}

export interface ResolvedChannel {
  readonly channel: Channel;
  readonly channelName: string;
  readonly chatId: string;
}

export class ChannelRegistry extends Context.Service<
  ChannelRegistry,
  {
    resolve(threadId: string): Effect.Effect<ResolvedChannel, UnknownChannelError>;
    get(name: string): Effect.Effect<Channel, UnknownChannelError>;
    readonly adapters: Record<string, Adapter>;
  }
>()("mizook/ChannelRegistry") {
  static readonly layer = Layer.effect(ChannelRegistry)(
    Effect.gen(function* () {
      const telegram = yield* TelegramChannel;
      const channels: Record<string, Channel> = { telegram };

      const get = (name: string) =>
        Effect.sync(() => channels[name]).pipe(
          Effect.flatMap((channel) =>
            channel
              ? Effect.succeed<Channel>(channel)
              : Effect.fail(new UnknownChannelError({ channelName: name })),
          ),
        );
      return ChannelRegistry.of({
        // Discord slots in here by name when landed.
        resolve: (threadId) => {
          const channelName = threadId.split(":")[0];
          return get(channelName).pipe(
            Effect.map((channel): ResolvedChannel => {
              const { chatId } = channel.decodeThreadId(threadId);
              return { channel, channelName, chatId };
            }),
          );
        },
        get,
        adapters: Object.fromEntries(
          Object.entries(channels).map(([name, ch]) => [name, ch.adapter]),
        ),
      });
    }),
  );
}
