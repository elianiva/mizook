// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";
import {
  Autocomplete,
  Combobox,
  Command,
  Dialog,
  HoverCard,
  Listbox,
  Menu,
  NavigationMenu,
  Popover,
  Select,
  Tabs,
  Tooltip,
} from "./index.ts";
import { flattenEntries, listItems, type Entry, type ListParts } from "./list-items.ts";
import { renderPhase } from "./internal/render.ts";
import type { Component } from "./core.ts";

const entries: ReadonlyArray<Entry> = [
  "Plain",
  { type: "separator" },
  {
    type: "group",
    label: "Fruit",
    items: [
      { value: "apple", label: "Apple" },
      { value: "pear", label: "Pear", disabled: true },
    ],
  },
  { type: "group", items: [] },
];

const fake: ListParts<never> = Object.fromEntries(
  ["item", "group", "group-label", "separator", "item-text"].map((slot) => [
    slot,
    (props: unknown, _a: unknown, children: ReadonlyArray<unknown>) => ({ slot, props, children }),
  ]),
) as never;

test("listItems renders options, separators and labelled groups, and drops empty groups", () => {
  const out = listItems(fake, entries) as unknown as ReadonlyArray<{
    slot: string;
    props: Record<string, unknown>;
    children: ReadonlyArray<{ slot: string; props: Record<string, unknown> }>;
  }>;
  expect(out.map((row) => row.slot)).toEqual(["item", "separator", "group"]);
  const group = out[2];
  expect(group?.children.map((row) => row.slot)).toEqual(["group-label", "item", "item"]);
  expect(group?.children[2]?.props).toMatchObject({
    value: "pear",
    group: "Fruit",
    disabled: true,
  });
  expect(flattenEntries(entries).map((item) => item.value)).toEqual(["Plain", "apple", "pear"]);
});

const render = <S, Slot extends string>(
  component: Component<S, Slot>,
  state: S,
  slot: Slot,
  props = {},
) => {
  const rendered = renderPhase(component.primitive, { ...component.options(state), id: "k" });
  return { present: rendered.present(slot, props), attrs: rendered.attrs(slot, props) };
};

test("the new slots render", () => {
  const items = [{ value: "a", label: "A" }];
  const select = { ...Select.init({ key: "s", items, value: "a" }), open: true, mounted: true };
  for (const slot of [
    "label",
    "value",
    "arrow",
    "clear",
    "viewport",
    "status",
    "input",
    "separator",
    "empty",
  ] as const)
    expect(() => render(Select.component, select, slot)).not.toThrow();
  expect(render(Select.component, select, "group", { group: "G" }).attrs["role"]).toBe("group");
  expect(render(Select.component, select, "group-label", { group: "G" }).attrs["id"]).toContain(
    "group",
  );
  const combo = { ...Combobox.init({ key: "c", items }), open: true };
  for (const slot of ["value", "arrow", "viewport", "header", "separator", "status"] as const)
    expect(() => render(Combobox.component, combo, slot)).not.toThrow();
  const auto = { ...Autocomplete.init({ key: "a", items: ["x"] }), open: true };
  for (const slot of ["arrow", "viewport", "header", "separator", "status"] as const)
    expect(() => render(Autocomplete.component, auto, slot)).not.toThrow();
  const cmd = Command.init({ key: "m", items });
  for (const slot of ["group", "separator", "page", "shortcut", "status"] as const)
    expect(() =>
      render(Command.component, cmd, slot, slot === "group" ? { group: "G" } : {}),
    ).not.toThrow();
  const list = Listbox.init({ key: "l" });
  for (const slot of ["group", "separator"] as const)
    expect(() =>
      render(Listbox.component, list, slot, slot === "group" ? { group: "G" } : {}),
    ).not.toThrow();
});

test("popup and navigation slots render", () => {
  const popup = { key: "p", open: true, mounted: true };
  for (const slot of ["viewport", "shortcut"] as const)
    expect(() => render(Menu.component, { ...Menu.init(popup) }, slot)).not.toThrow();
  for (const slot of ["arrow", "viewport", "shortcut"] as const)
    expect(() => render(Popover.component, Popover.init(popup), slot)).not.toThrow();
  expect(() => render(Tooltip.component, Tooltip.init(popup), "arrow")).not.toThrow();
  expect(() => render(HoverCard.component, HoverCard.init(popup), "arrow")).not.toThrow();
  expect(() =>
    render(Dialog.component, Dialog.init({ key: "d", open: true }), "shortcut"),
  ).not.toThrow();
  for (const slot of ["indicator", "viewport"] as const)
    expect(() =>
      render(NavigationMenu.component, NavigationMenu.init({ key: "n" }), slot),
    ).not.toThrow();
  expect(() =>
    render(Tabs.component, Tabs.init({ key: "t", value: "a" }), "indicator"),
  ).not.toThrow();
});
