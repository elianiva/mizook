import { Effect } from "effect";
import { Mount } from "foldkit";

import { Message } from "./message.ts";

/** How close to the bottom counts as reading the latest. */
const NEAR_BOTTOM_PX = 24;

/**
 * Keeps a scrolling thread at its bottom while the user is there, so a reply
 * streams into view. Scrolling up stops it, and the page stays where the user
 * left it; scrolling back to the bottom starts it again.
 */
export const FollowLatest = Mount.define("FollowLatest", {
  messages: [Message.CompletedScroll],
  execute: ({ element }) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const scroller = element as HTMLElement;
          let following = true;
          let top = scroller.scrollTop;
          const onScroll = () => {
            const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
            // Shrinking content pulls a scroller at its bottom up too, with no gap left.
            if (scroller.scrollTop < top && gap > 1) following = false;
            else if (gap <= NEAR_BOTTOM_PX) following = true;
            top = scroller.scrollTop;
          };
          const resized = new ResizeObserver(() => {
            if (following) scroller.scrollTop = scroller.scrollHeight;
          });
          resized.observe(scroller);
          for (const child of scroller.children) resized.observe(child);
          scroller.addEventListener("scroll", onScroll, { passive: true });
          return { resized, onScroll };
        }),
        ({ resized, onScroll }) =>
          Effect.sync(() => {
            resized.disconnect();
            element.removeEventListener("scroll", onScroll);
          }),
      );
      return Message.CompletedScroll();
    }),
});
