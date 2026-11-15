import { expect, test } from "vite-plus/test";
import { COMMANDS } from "../src/command-list.ts";

test("every menu entry fits Telegram's rules: lowercase name up to 32 characters, a short description", () => {
  expect(new Set(COMMANDS.map((c) => c.command)).size).toBe(COMMANDS.length);
  for (const { command, description } of COMMANDS) {
    expect(command).toMatch(/^[a-z_]{1,32}$/);
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(256);
  }
});
