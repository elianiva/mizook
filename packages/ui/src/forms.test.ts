// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";
import { Checkbox, DateInput, Message, NumberInput, Rating, Slider, TokenInput } from "./index.ts";
import { hiddenInputs } from "./form-inputs.ts";
import { renderPhase } from "./internal/render.ts";
import { component as checkbox } from "./checkbox.ts";
import { component as slider } from "./slider.ts";

const attrsOf = (
  c: { primitive: Parameters<typeof renderPhase>[0]; options: (s: never) => object },
  state: never,
  key: string,
  slot: string,
  props = {},
) => renderPhase(c.primitive, { ...c.options(state), id: key }).attrs(slot, props);

test("a named checkbox and slider write a hidden input a form submits", () => {
  const box = Checkbox.init({ key: "c", checked: true, name: "news" });
  expect(attrsOf(checkbox, box as never, "c", "input")).toMatchObject({
    name: "news",
    checked: "",
  });
  const volume = Slider.init({ key: "s", value: [30], name: "volume" });
  expect(attrsOf(slider, volume as never, "s", "input")).toMatchObject({
    name: "volume",
    value: "30",
  });
});

test("hiddenInputs makes one input per value, and none without a name", () => {
  expect(hiddenInputs({} as never, { name: "", values: ["a"] })).toEqual([]);
});

test("number input folds a snapshot and a typed text", () => {
  const state = NumberInput.init({ key: "n", value: 2 });
  const stepped = NumberInput.update(
    state,
    Message.ChangedUiState({
      component: "number-input",
      key: "n",
      snapshot: { value: 3 },
      reason: "x",
    }),
  );
  expect(stepped).toMatchObject({ value: 3, text: "3" });
  const typed = NumberInput.update(
    stepped,
    Message.TypedUiText({ component: "number-input", key: "n", value: "1.5" }),
  );
  expect(typed).toMatchObject({ value: 1.5, text: "1.5" });
});

test("date input lists its segments, rating its star values, token input its text", () => {
  const date = DateInput.init({ key: "d", value: "2026-11-17" });
  const segments = DateInput.segments(date);
  expect(segments.filter((s) => s.editable).map((s) => s.type)).toEqual(["month", "day", "year"]);
  expect(Rating.itemValues(Rating.init({ key: "r", step: 0.5 }), 1)).toEqual(["0.5", "1"]);
  const tokens = TokenInput.init({
    key: "t",
    value: ["Hi ", { type: "mention", value: "ada", label: "@ada" }],
  });
  expect(TokenInput.textOf(tokens)).toContain("@ada");
  expect(Checkbox.toggled(Checkbox.groupInit({ key: "g" }), "a", true).value).toEqual(["a"]);
});
