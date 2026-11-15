import type { ConversationView } from "@earendil-works/pi-durable";
import { Option, Schema } from "effect";

/** Telegram refuses a message over 4096 characters, and an edit cannot grow past it. */
export const STREAM_MAX_CHARS = 3_800;

const Live = Schema.Struct({
  generation: Schema.optionalKey(
    Schema.Struct({
      message: Schema.optionalKey(
        Schema.Struct({
          content: Schema.Array(
            Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
          ),
        }),
      ),
    }),
  ),
});
const decodeLive = Schema.decodeUnknownOption(Live);

export interface LivePartial {
  /** Names the model call the text belongs to: a new call, after tools ran, has a new key. */
  readonly key: number;
  /** All the text of the call so far. */
  readonly text: string;
}

/**
 * The text of the response the model is writing now, from pi-durable's live state. Each finished
 * model call commits an entry, so the newest entry's id tells one call from the next.
 */
export const livePartial = (view: ConversationView): LivePartial | undefined => {
  const live = decodeLive(view.docs["pi.live"] ?? {});
  if (Option.isNone(live)) return undefined;
  const content = live.value.generation?.message?.content;
  if (!content) return undefined;
  const text = content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("");
  return { key: view.entries.at(-1)?.id ?? 0, text };
};

/** A queue read as an async iterable of chunks, the shape Chat SDK streams. */
const chunks = () => {
  const buffer: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(chunk: string) {
      buffer.push(chunk);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = buffer.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
};

type Sink = ReturnType<typeof chunks>;

/**
 * Turns the growing text of each model call into one streamed message per call: a call that writes
 * text before it uses a tool streams as its own message, and the final answer is the last one.
 * `post` sends one stream of chunks and settles when the message is complete.
 */
export class ReplyStream {
  #current:
    | { readonly key: number; readonly sink: Sink; readonly done: Promise<boolean>; text: string }
    | undefined;
  readonly #post: (stream: AsyncIterable<string>) => Promise<unknown>;

  readonly #log: (event: string) => void;

  constructor(
    post: (stream: AsyncIterable<string>) => Promise<unknown>,
    log: (event: string) => void = () => {},
  ) {
    this.#post = post;
    this.#log = log;
  }

  /** The text of the model call `key` is now `text` (all of it, not the new part). Synchronous. */
  update({ key, text }: LivePartial): void {
    const wanted = text.trimStart();
    if (wanted.trim() === "") return;
    if (this.#current && this.#current.key !== key) {
      this.#current.sink.close();
      this.#current = undefined;
    }
    if (!this.#current) {
      const sink = chunks();
      this.#log(`started for call ${key}`);
      const done = this.#post(sink).then(
        () => true,
        (error: unknown) => {
          this.#log(`failed: ${String(error)}`);
          return false;
        },
      );
      this.#current = { key, sink, done, text: "" };
    }
    const target = wanted.slice(0, STREAM_MAX_CHARS);
    // The text only grows. Anything else is left as it was.
    if (target.length > this.#current.text.length && target.startsWith(this.#current.text)) {
      this.#current.sink.push(target.slice(this.#current.text.length));
      this.#current.text = target;
    }
  }

  /**
   * The turn is answered with `reply`. Finish the streamed message with the end of it, and give
   * back what still has to be posted: nothing when the stream carried the whole reply, the
   * rest when it was too long to stream, the whole reply when the stream was not part of it.
   */
  async finish(reply: string): Promise<string> {
    const current = this.#current;
    this.#current = undefined;
    if (!current) return reply;
    const streamed = current.text.trimEnd();
    if (!reply.startsWith(streamed)) {
      this.#log(`the reply does not start with the ${streamed.length} streamed characters`);
      current.sink.close();
      await current.done;
      return reply;
    }
    const upTo = Math.min(reply.length, STREAM_MAX_CHARS);
    if (upTo > current.text.length) current.sink.push(reply.slice(current.text.length, upTo));
    current.sink.close();
    const ok = await current.done;
    return ok ? reply.slice(upTo) : reply;
  }
}
