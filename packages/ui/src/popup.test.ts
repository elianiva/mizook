import { expect, test } from "vite-plus/test";
import { Menu, Select } from "./index.ts";

// The lifecycle rule, once, for every popup: closing does not unmount; the completion does.
test("closing keeps the content mounted until the exit completes", () => {
  const open = { ...Menu.init({ key: "m" }), open: true, mounted: true };
  const closing = Menu.component.fold(open, { open: false });
  expect(closing).toMatchObject({ open: false, mounted: true });
  const done = Menu.component.fold(closing, { open: false, mounted: false });
  expect(done).toMatchObject({ open: false, mounted: false });
});

test("a menu records the item pressed, and a select the value chosen", () => {
  const menu = Menu.component.fold(Menu.init({ key: "m" }), { open: false, action: "edit" });
  expect(menu.action).toBe("edit");
  const items = [{ value: "a", label: "A" }];
  const chosen = Select.component.fold(Select.init({ key: "s", items }), {
    value: "a",
    open: false,
  });
  expect(chosen.value).toBe("a");
  expect(Select.labelOf(chosen, "a")).toBe("A");
});
