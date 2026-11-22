import { expect, test } from "vite-plus/test";
import { COMMANDS, menuWith } from "../src/command-list.ts";

test("every menu entry fits Telegram's rules: lowercase name up to 32 characters, a short description", () => {
  expect(new Set(COMMANDS.map((c) => c.command)).size).toBe(COMMANDS.length);
  for (const { command, description } of COMMANDS) {
    expect(command).toMatch(/^[a-z_]{1,32}$/);
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(256);
  }
});

test("the menu adds one command per agent, never over a real command, within Telegram's limits", () => {
  const menu = menuWith([
    { slug: "grok", name: "Grok", role: "Fact-checks claims.\nCites sources." },
    { slug: "help", name: "Impostor", role: "" },
    { slug: "tutor", name: "Tutor", role: "x".repeat(400) },
  ]);
  const names = menu.map((c) => c.command);
  expect(names.filter((n) => n === "help")).toHaveLength(1);
  expect(menu.find((c) => c.command === "grok")?.description).toBe("Grok: Fact-checks claims.");
  expect(menu.find((c) => c.command === "tutor")?.description.length).toBe(256);
  expect(names.slice(0, COMMANDS.length)).toEqual(COMMANDS.map((c) => c.command));
});
