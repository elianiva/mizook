// @vitest-environment happy-dom
import { accordion } from "@ui-sdk/core/accordion";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  attach,
  type Binding,
  type Change,
  closeRegistry,
  makeRegistry,
  type Registry,
  liveInstance,
  LOCK_MARKER,
  sync,
} from "./internal/bind.ts";
import { primitiveOf } from "./internal/render.ts";

type State = { key: string; value: ReadonlyArray<string> };
const strings = (value: unknown) => (Array.isArray(value) ? (value as Array<string>) : []);

const make = (guard: Binding["guard"] = () => true): Binding => ({
  primitive: primitiveOf(accordion),
  options: (state) => ({ value: [...(state as State).value] }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  completions: {},
  fold: (state, snapshot) => ({ ...(state as State), value: strings(snapshot["value"]) }),
  guard,
  foldkitEvents: {},
});

const state: State = { key: "k", value: [] };
const trigger = () => {
  const el = document.createElement("button");
  document.body.append(el);
  return el;
};
const mount = (binding: Binding, el: HTMLElement, changes: Array<Change>, s: unknown = state) =>
  attach(registry, "accordion", binding, "k", s, "trigger", { value: "a" }, el, (c) =>
    changes.push(c),
  );

let registry: Registry;
beforeEach(() => {
  registry = makeRegistry(new Map());
});
afterEach(() => {
  closeRegistry(registry);
  document.body.replaceChildren();
});

test("attaching the same element twice yields one change per click", () => {
  const el = trigger();
  const changes: Array<Change> = [];
  const binding = make();
  mount(binding, el, changes);
  mount(binding, el, changes);
  el.click();
  expect(changes).toHaveLength(1);
  expect(changes[0]?.snapshot).toEqual({ value: ["a"] });
});

test("cleanup of a replaced binding does not tear down the live one", () => {
  const el = trigger();
  const changes: Array<Change> = [];
  const binding = make();
  const first = mount(binding, el, changes);
  const second = mount(binding, el, changes);
  first();
  el.click();
  expect(changes).toHaveLength(1);
  second();
  expect(liveInstance(registry, "accordion", "k")).toBeUndefined();
});

test("sync reuses the entry instead of rebuilding it", () => {
  const el = trigger();
  const changes: Array<Change> = [];
  mount(make(), el, changes);
  const before = liveInstance(registry, "accordion", "k");
  sync(registry, "accordion", "k", { key: "k", value: ["a"] });
  expect(liveInstance(registry, "accordion", "k")).toBe(before);
  expect(before?.get()).toMatchObject({ value: ["a"] });
  el.click();
  expect(changes[0]?.snapshot).toEqual({ value: [] });
});

test("a guard veto does not move the instance and emits a refused change", () => {
  const el = trigger();
  const changes: Array<Change> = [];
  mount(
    make(() => false),
    el,
    changes,
  );
  el.click();
  expect(changes).toEqual([{ snapshot: { value: ["a"] }, reason: "trigger-press", refused: true }]);
  expect(liveInstance(registry, "accordion", "k")?.get()).toMatchObject({ value: [] });
  el.click();
  expect(changes).toHaveLength(2);
  expect(changes[1]?.snapshot).toEqual({ value: ["a"] });
});

test("two dialogs keep independent state: one open, one finishing its exit", async () => {
  const { Dialog } = await import("./index.ts");
  const { bindingOf } = await import("./core.ts");
  const binding = bindingOf(Dialog.component);
  const open = (key: string, isOpen: boolean) => Dialog.init({ key, open: isOpen });
  const aChanges: Array<Change> = [];
  const bChanges: Array<Change> = [];
  const a = trigger();
  const b = trigger();
  attach(registry, "dialog", binding, "a", open("a", true), "trigger", {}, a, (c) =>
    aChanges.push(c),
  );
  attach(registry, "dialog", binding, "b", open("b", true), "trigger", {}, b, (c) =>
    bChanges.push(c),
  );
  expect(liveInstance(registry, "dialog", "a")).not.toBe(liveInstance(registry, "dialog", "b"));

  // The Model closes b only. With no element shown, its exit completes at once.
  sync(registry, "dialog", "b", open("b", false));

  expect(liveInstance(registry, "dialog", "a")?.get()).toMatchObject({ open: true });
  expect(liveInstance(registry, "dialog", "b")?.get()).toMatchObject({
    open: false,
    mounted: false,
  });
  expect(aChanges).toEqual([]);
  expect(bChanges.map((c) => c.snapshot["mounted"])).toEqual([false]);
});

const lockBinding = (): Binding => ({ ...make(), lockSlot: "trigger" });
const foreign = () => document.documentElement.style.setProperty("overflow", "hidden");

test("a scroll lock nobody in the registry wrote warns once", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  foreign();
  mount(lockBinding(), trigger(), []);
  attach(registry, "accordion", lockBinding(), "other", state, "trigger", {}, trigger(), () => {});
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toContain("another provider");
  warn.mockRestore();
  document.documentElement.style.removeProperty("overflow");
});

test("our own lock is stamped, so a second adapter modal does not warn", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const releaseFirst = mount(lockBinding(), trigger(), []);
  expect(document.documentElement.hasAttribute(LOCK_MARKER)).toBe(true);
  // Core's own lock lands after our stamp, as it does for a real modal.
  foreign();
  attach(registry, "accordion", lockBinding(), "second", state, "trigger", {}, trigger(), () => {});
  expect(warn).not.toHaveBeenCalled();
  releaseFirst();
  document.documentElement.style.removeProperty("overflow");
  warn.mockRestore();
});

test("the marker is removed with the last modal, and destroyAll clears it", () => {
  const release = mount(lockBinding(), trigger(), []);
  expect(document.documentElement.hasAttribute(LOCK_MARKER)).toBe(true);
  release();
  expect(document.documentElement.hasAttribute(LOCK_MARKER)).toBe(false);
});
