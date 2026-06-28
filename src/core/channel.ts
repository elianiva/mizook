import { Context, Layer, type Effect } from "effect";
import type { Adapter } from "chat";

export interface ChatTarget {
  readonly platform: string;
  readonly chatId: string;
}

export interface ChannelInterface {
  readonly adapter: Adapter;
  readonly postNotification: (target: ChatTarget, message: string) => Effect.Effect<void>;
  readonly postPhoto: (
    target: ChatTarget,
    photo: Uint8Array,
    caption: string,
  ) => Effect.Effect<void>;
}

export class Channel extends Context.Service<Channel, ChannelInterface>()("@mizook/Channel") {}

export const ChannelLayer = (implementation: ChannelInterface) =>
  Layer.succeed(Channel, Channel.of(implementation));
