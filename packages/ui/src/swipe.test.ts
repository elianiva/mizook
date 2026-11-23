// @vitest-environment happy-dom
import { Effect, Fiber, Stream } from "effect";
import { afterEach, expect, test } from "vite-plus/test";

import { swipeDrawer } from "./swipe.ts";

const touch = (x: number, y: number) => ({ clientX: x, clientY: y });

const fire = (target: EventTarget, type: string, x: number, y: number) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const points = [touch(x, y)];
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : points },
    targetTouches: { value: type === "touchend" ? [] : points },
    changedTouches: { value: points },
  });
  target.dispatchEvent(event);
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const viewport = (width: number) => {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
};

interface Drawing {
  readonly messages: ReadonlyArray<string>;
  stop: () => Promise<void>;
}

const draw = async (): Promise<Drawing> => {
  const messages: string[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(
      swipeDrawer<string>({
        maxWidth: 767,
        width: () => 340,
        open: () => "open",
        close: () => "close",
      }),
      (message) => Effect.sync(() => messages.push(message)),
    ),
  );
  return {
    messages,
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
  };
};

const panel = () => {
  const element = document.createElement("div");
  element.setAttribute("data-swipe-panel", "");
  element.setAttribute("data-open", "");
  element.getBoundingClientRect = () => ({ width: 340 }) as DOMRect;
  document.body.append(element);
  return element;
};

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-swiping");
  document.documentElement.removeAttribute("data-settling");
  document.documentElement.removeAttribute("data-swiped");
  document.documentElement.style.removeProperty("--swipe-offset");
  document.documentElement.style.removeProperty("--swipe-progress");
});

test("a right drag follows the finger and a release past half opens the menu", async () => {
  viewport(390);
  const drawing = await draw();
  fire(document, "touchstart", 20, 400);
  fire(document, "touchmove", 120, 400);
  await tick();
  expect(drawing.messages).toEqual(["open"]);
  expect(document.documentElement.style.getPropertyValue("--swipe-offset")).toBe("100px");
  expect(document.documentElement.getAttribute("data-swiping")).toBe("");

  fire(document, "touchmove", 200, 400);
  fire(document, "touchend", 200, 400);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(drawing.messages).toEqual(["open"]);
  expect(document.documentElement.getAttribute("data-swiped")).toBe("");
  await drawing.stop();
});

test("a slow short drag settles back and closes a menu it opened", async () => {
  viewport(390);
  const drawing = await draw();
  fire(document, "touchstart", 20, 400);
  await new Promise((resolve) => setTimeout(resolve, 400));
  fire(document, "touchmove", 80, 400);
  fire(document, "touchend", 80, 400);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(drawing.messages).toEqual(["open", "close"]);
  expect(document.documentElement.hasAttribute("data-swiped")).toBe(false);
  await drawing.stop();
});

test("a left drag closes an open menu and follows the finger", async () => {
  viewport(390);
  panel();
  const drawing = await draw();
  fire(document, "touchstart", 300, 400);
  fire(document, "touchmove", 200, 400);
  await tick();
  expect(drawing.messages).toEqual([]);
  expect(document.documentElement.style.getPropertyValue("--swipe-offset")).toBe("240px");
  fire(document, "touchend", 200, 400);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(drawing.messages).toEqual(["close"]);
  await drawing.stop();
});

test("a drag that starts in a text field keeps its own horizontal movement", async () => {
  viewport(390);
  const input = document.createElement("input");
  document.body.append(input);
  const drawing = await draw();
  fire(input, "touchstart", 20, 400);
  fire(input, "touchmove", 160, 400);
  await tick();
  expect(drawing.messages).toEqual([]);
  expect(document.documentElement.hasAttribute("data-swiping")).toBe(false);
  await drawing.stop();
});
