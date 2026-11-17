import { expect, test } from "vite-plus/test";
import { ago } from "../apps/dashboard/src/format.ts";

test("ago names the largest unit that fits, and never a negative time", () => {
  const now = 1_000_000_000_000;
  const at = (seconds: number) => now - seconds * 1000;
  expect(ago(at(59), now)).toBe("just now");
  expect(ago(at(60), now)).toBe("1 min ago");
  expect(ago(at(3599), now)).toBe("59 min ago");
  expect(ago(at(3600), now)).toBe("1 h ago");
  expect(ago(at(47 * 3600), now)).toBe("47 h ago");
  expect(ago(at(48 * 3600), now)).toBe("2 d ago");
  expect(ago(now + 5000, now)).toBe("just now");
});
