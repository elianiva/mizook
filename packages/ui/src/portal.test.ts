// @vitest-environment happy-dom
// The portal landmine, made executable. A bound element is found through the
// anchor above it, so an element moved out of the anchor's subtree has no
// registry. Whoever writes the first portaling component (a Mount that moves a
// part to `document.body`, as the Foldkit docs' PortalToBody example does) meets
// this test first.
import { Effect, Exit, Fiber, Stream } from "effect";
import { liveViewStateChanges } from "foldkit/mount";
import { afterEach, expect, test } from "vite-plus/test";
import { Accordion, BindPart, Ui } from "./index.ts";
import { UNBOUND_ATTRIBUTE } from "./registry.ts";

const bind = (element: HTMLElement) =>
  Effect.runPromiseExit(
    Stream.runDrain(
      BindPart({
        component: "accordion",
        key: "help",
        slot: "trigger",
        props: { value: "a" },
        state: Accordion.init({ key: "help" }),
        anchor: "",
      }).f(element, liveViewStateChanges),
    ),
  );

afterEach(() => document.body.replaceChildren());

test("a bound element moved out of the anchor subtree is unbound, loudly", async () => {
  // The app renders under `parent`, which is the anchor. `body` is outside it.
  const parent = document.body.appendChild(document.createElement("div"));
  const container = parent.appendChild(document.createElement("div"));
  Ui.layerOf([Accordion.component], container);
  const portal = document.body.appendChild(document.createElement("div"));

  const inside = parent.appendChild(document.createElement("button"));
  const moved = parent.appendChild(document.createElement("button"));
  portal.append(moved);

  expect(Exit.isFailure(await bind(moved))).toBe(true);
  expect(moved.getAttribute(UNBOUND_ATTRIBUTE)).toBe("accordion:trigger");
  // Control: the same part inside the anchor's subtree is not marked.
  inside.remove();
  parent.append(inside);
  const control = Effect.runFork(
    Stream.runDrain(
      BindPart({
        component: "accordion",
        key: "help",
        slot: "trigger",
        props: { value: "a" },
        state: Accordion.init({ key: "help" }),
        anchor: "",
      }).f(inside, liveViewStateChanges),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(inside.hasAttribute(UNBOUND_ATTRIBUTE)).toBe(false);
  await Effect.runPromise(Fiber.interrupt(control));
});
