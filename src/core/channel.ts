import type { Effect } from "effect";
import type { Adapter } from "chat";

export interface ChatTarget {
  readonly platform: string;
  readonly chatId: string;
}

export interface ChannelInterface {
  readonly name: string;
  readonly adapter: Adapter;
  readonly decodeThreadId: (threadId: string) => { chatId: string };
  readonly postNotification: (target: ChatTarget, message: string) => Effect.Effect<void>;
  readonly postPhoto: (
    target: ChatTarget,
    photo: Uint8Array,
    caption: string,
  ) => Effect.Effect<void>;
}
