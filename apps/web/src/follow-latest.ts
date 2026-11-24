import { Effect, Queue, Schema, Stream } from "effect";
import { Mount } from "foldkit";

import { Message } from "./message.ts";

/** How close to the bottom counts as reading the latest. */
const NEAR_BOTTOM_PX = 24;

/**
 * Keeps a scrolling thread at its bottom while the user is there, so a reply
 * streams into view. Scrolling up stops it, and the page stays where the user
 * left it; scrolling back to the bottom starts it again. It reports whether
 * the reader is following the latest message, so the thread shows its Latest
 * button only while they are not.
 */
export const FollowLatest = Mount.defineStream("FollowLatest", {
  args: { threadId: Schema.String },
  messages: [Message.ScrolledThread],
  execute: ({ element, threadId }) =>
    Stream.callback<typeof Message.ScrolledThread.Type>((queue) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const scroller = element as HTMLElement;
            const gap = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
            let following = true;
            let reported: boolean | undefined;
            let top = scroller.scrollTop;
            const report = () => {
              if (following === reported) return;
              reported = following;
              Queue.offerUnsafe(queue, Message.ScrolledThread({ threadId, atBottom: following }));
            };
            const onScroll = () => {
              // Shrinking content pulls a scroller at its bottom up too, with no gap left.
              if (scroller.scrollTop < top && gap() > 1) following = false;
              else if (gap() <= NEAR_BOTTOM_PX) following = true;
              top = scroller.scrollTop;
              report();
            };
            const resized = new ResizeObserver(() => {
              if (following) scroller.scrollTop = scroller.scrollHeight;
              else if (gap() <= NEAR_BOTTOM_PX) following = true;
              report();
            });
            resized.observe(scroller);
            for (const child of scroller.children) resized.observe(child);
            scroller.addEventListener("scroll", onScroll, { passive: true });
            // A thread that is already at its bottom starts following it.
            following = gap() <= NEAR_BOTTOM_PX;
            report();
            return { resized, onScroll };
          }),
          ({ resized, onScroll }) =>
            Effect.sync(() => {
              resized.disconnect();
              element.removeEventListener("scroll", onScroll);
            }),
        );
        return yield* Effect.never;
      }),
    ),
});
