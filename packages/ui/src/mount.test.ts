// @vitest-environment happy-dom
// The Mount's side of the registry: finding it, and failing loudly when it cannot.
import { Effect, Exit, Fiber, Option, Stream } from "effect";
import { liveViewStateChanges } from "foldkit/mount";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { Accordion, BindPart, Ui } from "./index.ts";
import { liveInstance } from "./internal/bind.ts";
import { findRegistry, UNBOUND_ATTRIBUTE } from "./registry.ts";

const part = (element: HTMLElement, anchor = "") =>
  Stream.runDrain(
    BindPart({
      component: "accordion",
      key: "help",
      slot: "trigger",
      props: { value: "a" },
      state: Accordion.init({ key: "help" }),
      anchor,
    }).f(element, liveViewStateChanges),
  );

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A parent in the document, with one container per id, each holding a root the app "rendered". */
const apps = (ids: ReadonlyArray<string>) => {
  const parent = document.body.appendChild(document.createElement("div"));
  return ids.map((id) => {
    const container = parent.appendChild(document.createElement("div"));
    container.id = id;
    Ui.layerOf([Accordion.component], container);
    const root = parent.appendChild(document.createElement("main"));
    const trigger = root.appendChild(document.createElement("button"));
    return { container, root, trigger, parent };
  });
};

afterEach(() => {
  vi.unstubAllEnvs();
  document.body.replaceChildren();
});

test("a Mount with no registry marks its element and fails in dev", async () => {
  const el = document.body.appendChild(document.createElement("button"));
  const exit = await Effect.runPromiseExit(part(el));
  expect(Exit.isFailure(exit)).toBe(true);
  expect(el.getAttribute(UNBOUND_ATTRIBUTE)).toBe("accordion:trigger");
});

test("outside dev it marks the element and logs, and does not throw", async () => {
  vi.stubEnv("DEV", false);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const el = document.body.appendChild(document.createElement("button"));
  const exit = await Effect.runPromiseExit(part(el));
  expect(Exit.isSuccess(exit)).toBe(true);
  expect(el.getAttribute(UNBOUND_ATTRIBUTE)).toBe("accordion:trigger");
  expect(error).toHaveBeenCalledTimes(1);
  error.mockRestore();
});

test("a lone app binds without an anchor id", async () => {
  const [app] = apps(["root"]);
  const fiber = Effect.runFork(part(app!.trigger));
  await tick();
  expect(app!.trigger.hasAttribute(UNBOUND_ATTRIBUTE)).toBe(false);
  const registry = findRegistry(app!.trigger, "root");
  expect(Option.isSome(registry)).toBe(true);
  await Effect.runPromise(Fiber.interrupt(fiber));
});

test("two apps under one parent stay apart when parts carry their anchor", async () => {
  const [a, b] = apps(["a", "b"]);
  const fiberA = Effect.runFork(part(a!.trigger, "a"));
  const fiberB = Effect.runFork(part(b!.trigger, "b"));
  await tick();
  const regA = findRegistry(a!.trigger, "a");
  const regB = findRegistry(b!.trigger, "b");
  const registryA = Option.getOrUndefined(regA)!;
  const registryB = Option.getOrUndefined(regB)!;
  expect(registryA).toBeDefined();
  expect(registryB).toBeDefined();
  expect(registryA).not.toBe(registryB);
  expect(liveInstance(registryA, "accordion", "help")).toBeDefined();
  expect(liveInstance(registryB, "accordion", "help")).toBeDefined();
  expect(liveInstance(registryA, "accordion", "help")).not.toBe(
    liveInstance(registryB, "accordion", "help"),
  );
  await Effect.runPromise(Fiber.interrupt(fiberA));
  await Effect.runPromise(Fiber.interrupt(fiberB));
});

test("with two apps, a part with no anchor id, or the wrong one, is unbound loudly", async () => {
  const [a] = apps(["a", "b"]);
  for (const anchor of ["", "c"]) {
    const el = a!.root.appendChild(document.createElement("button"));
    const exit = await Effect.runPromiseExit(part(el, anchor));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(el.getAttribute(UNBOUND_ATTRIBUTE)).toBe("accordion:trigger");
  }
});

test("the layer returns the anchor id, so a counter id is usable", async () => {
  const parent = document.body.appendChild(document.createElement("div"));
  const make = (id: string) => {
    const container = parent.appendChild(document.createElement("div"));
    container.id = id;
    const { anchorId } = Ui.layerOf([Accordion.component], container);
    const root = parent.appendChild(document.createElement("main"));
    return { anchorId, trigger: root.appendChild(document.createElement("button")) };
  };
  const apps = [make(""), make(""), make("x"), make("x")];
  expect(apps.map((app) => app.anchorId)).toEqual(["app-0", "app-1", "x", "app-3"]);
  // Each part, rendered with the id its layer returned, binds to its own registry.
  const fibers = apps.map((app) => Effect.runFork(part(app.trigger, app.anchorId)));
  await tick();
  for (const app of apps) expect(app.trigger.hasAttribute(UNBOUND_ATTRIBUTE)).toBe(false);
  const registries = apps.map((app) => findRegistry(app.trigger, app.anchorId));
  expect(new Set(registries.map(Option.getOrUndefined)).size).toBe(4);
  for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
});

test("an app rendering into body anchors on body, the ceiling of the walk", async () => {
  Ui.layerOf([Accordion.component], document.body);
  const root = document.body.appendChild(document.createElement("main"));
  const trigger = root.appendChild(document.createElement("button"));
  const fiber = Effect.runFork(part(trigger));
  await tick();
  expect(trigger.hasAttribute(UNBOUND_ATTRIBUTE)).toBe(false);
  await Effect.runPromise(Fiber.interrupt(fiber));
  Reflect.deleteProperty(document.body, Symbol.for("foldlab.ui.registries"));
});
