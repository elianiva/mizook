import { createDomRenderer } from "@pierre/words/html";
import { Effect } from "effect";
import { Mount } from "foldkit";

import { Message } from "./message.ts";
import { domOptions } from "./words.ts";

/**
 * Hands an element to the Words DOM renderer. The view writes the Markdown to
 * `data-source` and whether it is still arriving to `data-streaming`; a Mount's
 * args are fixed when it runs, so the element's attributes carry the updates.
 */
export const StreamMarkdown = Mount.define("StreamMarkdown", {
  messages: [Message.CompletedFocus],
  execute: ({ element }) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const root = element as HTMLElement;
          const renderer = createDomRenderer(root, domOptions);
          renderer.connect();
          const render = () => {
            const streaming = root.dataset["streaming"] === "true";
            renderer.update(
              root.dataset["source"] ?? "",
              streaming,
              streaming,
              streaming ? { animation: "fadeIn", duration: 180 } : false,
              streaming ? "block" : undefined,
            );
          };
          render();
          const observer = new MutationObserver(render);
          observer.observe(root, {
            attributes: true,
            attributeFilter: ["data-source", "data-streaming"],
          });
          return { renderer, observer };
        }),
        ({ renderer, observer }) =>
          Effect.sync(() => {
            observer.disconnect();
            renderer.disconnect();
          }),
      );
      return Message.CompletedFocus();
    }),
});
