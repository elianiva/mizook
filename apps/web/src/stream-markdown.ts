import { glyphs } from "@mizook/design/icons";
import { createDomRenderer } from "@pierre/words/html";
import { Effect } from "effect";
import { Mount } from "foldkit";

import { Message } from "./message.ts";
import { domOptions } from "./words.ts";

/**
 * A design glyph as an alpha mask. Words rewrites a code control's text after a
 * copy, so the icon must be a pseudo-element that its text cannot replace.
 */
const maskIcon = (name: "copy" | "download" | "check"): string => {
  const shape = glyphs[name];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><path d="${shape.d}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};

const controlIcons = {
  copy: maskIcon("copy"),
  download: maskIcon("download"),
  copied: maskIcon("check"),
} as const;

/** The slowest a reply is revealed, so a steady stream reads at an even pace. */
const MIN_CHARS_PER_SECOND = 90;
/** How long a burst of text may wait before it is all shown. */
const CATCH_UP_MS = 250;
/** A frame after a hidden tab or a stall counts as this long at most. */
const MAX_FRAME_MS = 100;
/** A little after Words resets its copy label, so the check mark outlives it. */
const COPY_FEEDBACK_MS = 2100;

const wordEnd = /\s*\S+(?=\s)/y;

/** Where the next whole word after `from` ends, or nothing while it is still arriving. */
const nextWordEnd = (text: string, from: number): number | undefined => {
  wordEnd.lastIndex = from;
  return wordEnd.test(text) ? wordEnd.lastIndex : undefined;
};

/**
 * Hands an element to the Words DOM renderer. The view writes the Markdown to
 * `data-source` and whether it is still arriving to `data-streaming`; a Mount's
 * args are fixed when it runs, so the element's attributes carry the updates.
 *
 * While the text streams, it is revealed a word at a time, so tokens that
 * arrive in bursts still fade in at an even pace.
 */
export const StreamMarkdown = Mount.define("StreamMarkdown", {
  messages: [Message.CompletedFocus],
  execute: ({ element }) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const root = element as HTMLElement;
          root.style.setProperty("--code-icon-copy", controlIcons.copy);
          root.style.setProperty("--code-icon-download", controlIcons.download);
          root.style.setProperty("--code-icon-copied", controlIcons.copied);

          const renderer = createDomRenderer(root, domOptions);
          renderer.connect();

          const copyTimers = new Map<HTMLButtonElement, number>();
          const markCopied = (event: Event) => {
            const target = event.target instanceof Element ? event.target : null;
            const button =
              target === null
                ? null
                : target.closest<HTMLButtonElement>('button[data-code-action="copy"]');
            if (button === null || !root.contains(button)) return;
            const timer = copyTimers.get(button);
            if (timer !== undefined) window.clearTimeout(timer);
            button.setAttribute("data-copied", "true");
            copyTimers.set(
              button,
              window.setTimeout(() => {
                button.removeAttribute("data-copied");
                copyTimers.delete(button);
              }, COPY_FEEDBACK_MS),
            );
          };
          root.addEventListener("click", markCopied);

          let target = root.dataset["source"] ?? "";
          let shown = target;
          let budget = 0;
          let last = 0;
          let frame: number | undefined;

          const draw = (streaming: boolean) =>
            renderer.update(
              shown,
              streaming,
              streaming,
              streaming ? { animation: "fadeIn", duration: 180 } : false,
              streaming ? "block" : undefined,
            );

          const tick = (now: number) => {
            frame = undefined;
            const elapsed = Math.min(now - last, MAX_FRAME_MS);
            last = now;
            const backlog = target.length - shown.length;
            budget +=
              (Math.max(MIN_CHARS_PER_SECOND, (backlog * 1000) / CATCH_UP_MS) * elapsed) / 1000;
            let end = shown.length;
            for (
              let next = nextWordEnd(target, end);
              next !== undefined && next - shown.length <= budget;
              next = nextWordEnd(target, end)
            )
              end = next;
            if (end > shown.length) {
              budget -= end - shown.length;
              shown = target.slice(0, end);
              draw(true);
            }
            if (nextWordEnd(target, end) === undefined) budget = 0;
            else frame = requestAnimationFrame(tick);
          };

          const sync = () => {
            target = root.dataset["source"] ?? "";
            if (root.dataset["streaming"] !== "true") {
              if (frame !== undefined) cancelAnimationFrame(frame);
              frame = undefined;
              shown = target;
              draw(false);
              return;
            }
            // A rewrite keeps only what the new text still starts with.
            if (!target.startsWith(shown)) {
              let common = 0;
              while (common < shown.length && shown[common] === target[common]) common++;
              shown = shown.slice(0, common);
              draw(true);
            }
            if (frame === undefined && nextWordEnd(target, shown.length) !== undefined) {
              last = performance.now();
              frame = requestAnimationFrame(tick);
            }
          };

          draw(root.dataset["streaming"] === "true");
          const observer = new MutationObserver(sync);
          observer.observe(root, {
            attributes: true,
            attributeFilter: ["data-source", "data-streaming"],
          });
          return {
            renderer,
            observer,
            stop: () => {
              if (frame !== undefined) cancelAnimationFrame(frame);
              root.removeEventListener("click", markCopied);
              for (const timer of copyTimers.values()) window.clearTimeout(timer);
              copyTimers.clear();
            },
          };
        }),
        ({ renderer, observer, stop }) =>
          Effect.sync(() => {
            stop();
            observer.disconnect();
            renderer.disconnect();
          }),
      );
      return Message.CompletedFocus();
    }),
});
