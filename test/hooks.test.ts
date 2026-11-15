import { expect, test } from "vite-plus/test";
import { hookToken, hookTokenValid } from "../src/hooks.ts";

test("a webhook token belongs to one channel and one secret", async () => {
  const token = await hookToken("s1", "-100:5");
  expect(await hookTokenValid("s1", "-100:5", token)).toBe(true);
  expect(await hookTokenValid("s1", "-100:6", token)).toBe(false);
  expect(await hookTokenValid("s2", "-100:5", token)).toBe(false);
  expect(await hookTokenValid("s1", "-100:5", "")).toBe(false);
});
