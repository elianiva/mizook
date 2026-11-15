import { Context, type Effect } from "effect";
import type { ToolError } from "./errors.ts";
import type { Spend } from "./usage.ts";

export interface ChannelInfo {
  /** The Durable Object's name: `chatId` or `chatId:topicId`. */
  readonly doName: string;
  readonly threadId: string;
  readonly name: string;
  readonly lastActive: number;
}

/**
 * What a channel needs from outside itself, which only the Durable Object can give: its siblings
 * through the Hub, and a restart of its own runtime after its settings change.
 */
export class Host extends Context.Service<
  Host,
  {
    /** The link other services call to start a turn in this channel. */
    readonly hookUrl: Effect.Effect<string>;
    /** Rebuild this channel's runtime, so new settings take effect. */
    readonly reload: Effect.Effect<void>;
    /** Tell the Hub this channel exists and was just used. */
    register(threadId: string, name: string | undefined): Effect.Effect<void>;
    readonly channels: Effect.Effect<ReadonlyArray<ChannelInfo>>;
    /** Ask another channel a question, by its name, read-only. */
    ask(channel: string, question: string): Effect.Effect<string, ToolError>;
    /** What every channel spent. */
    readonly spendAll: Effect.Effect<
      ReadonlyArray<{ readonly name: string; readonly spend: Spend }>
    >;
    /** Write this channel's archive to the blob store and give the key. */
    readonly exportNow: Effect.Effect<string>;
  }
>()("mizook/Host") {}
