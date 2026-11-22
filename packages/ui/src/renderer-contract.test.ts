// @vitest-environment happy-dom
// Exercises every ui-sdk export this package relies on. A version bump that
// changes one fails here, in CI, instead of at runtime in a browser.
import { accordion } from "@ui-sdk/core/accordion";
import { attrs, bind, present } from "@ui-sdk/core/renderer";
import { expect, test } from "vite-plus/test";

test("renderer contract: attrs, present, part, get", () => {
  const instance = accordion({ id: "c1", value: ["a"] });
  expect(instance.get()).toMatchObject({ value: ["a"] });
  const state = instance.get();
  const trigger = instance.part("trigger", { value: "a" }, true);
  expect(attrs(trigger, { value: "a" }, state)).toMatchObject({
    "data-slot": "accordion-trigger",
    id: "c1-trigger-a",
    "aria-expanded": "true",
  });
  const panel = instance.part("panel", { value: "b" }, true);
  expect(present(panel, { value: "b" }, state)).toBe(false);
  instance.destroy();
});

test("renderer contract: bind, setOptions, destroy", () => {
  const instance = accordion({ id: "c2", value: [] });
  const el = document.createElement("button");
  document.body.append(el);
  const unbind = bind(instance.part("trigger", { value: "a" }), el);
  instance.setOptions({ id: "c2", value: ["a"] });
  expect(instance.get()).toMatchObject({ value: ["a"] });
  unbind();
  instance.destroy();
  instance.destroy();
});
