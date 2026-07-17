import type { Effect } from "effect";
import type { Adapter } from "chat";

export interface ChatTarget {
  readonly platform: string;
  readonly chatId: string;
}

// Shape a channel adapter provides. Each platform (telegram, discord, ...)
// becomes its own Context.Service implementing this.
export interface Channel {
  readonly adapter: Adapter;
  readonly decodeThreadId: (threadId: string) => { readonly chatId: string };
  readonly postNotification: (target: ChatTarget, message: string) => Effect.Effect<void, unknown>;
  readonly postPhoto: (
    target: ChatTarget,
    photo: Uint8Array,
    caption: string,
  ) => Effect.Effect<void, unknown>;
}
