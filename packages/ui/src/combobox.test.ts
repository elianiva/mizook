// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";
import { Combobox } from "./index.ts";
import { renderPhase } from "./internal/render.ts";
import { component } from "./combobox.ts";

const items = [
  { value: "email", label: "Email" },
  { value: "slack", label: "Slack" },
];

// ui-sdk hands itemToValue and itemToLabel a bare selected value, not only an item,
// when the filter hides the selected item. Returning undefined crashed the app.
test("itemToValue and itemToLabel accept a bare selected value", () => {
  const state = { ...Combobox.init({ key: "c", items, multiple: true }), value: ["slack"] };
  const options = component.options(state) as {
    itemToValue: (item: unknown) => unknown;
    itemToLabel: (item: unknown) => unknown;
  };
  expect(options.itemToValue("slack")).toBe("slack");
  expect(options.itemToLabel("slack")).toBe("Slack");
  expect(options.itemToValue(items[0])).toBe("email");
  expect(options.itemToLabel(items[0])).toBe("Email");
});

test("a multi combobox with a selected item the query hides still renders", () => {
  const state = {
    ...Combobox.init({ key: "c", items, multiple: true }),
    value: ["slack"],
    query: "em",
    open: true,
  };
  const rendered = renderPhase(component.primitive, { ...component.options(state), id: "c" });
  expect(() => rendered.attrs("input", {})).not.toThrow();
});
