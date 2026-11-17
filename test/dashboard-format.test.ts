import { expect, test } from "vite-plus/test";
import { ago, describeSpec, until } from "../apps/dashboard/src/format.ts";

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

test("a cron reads as words when simple and as itself when not, and until counts forward", () => {
  const cron = (expr: string) =>
    describeSpec(JSON.stringify({ kind: "cron", expr, timezone: "Asia/Jakarta" }));
  expect(cron("0 19 * * 1-5").cadence).toBe("Weekdays at 19:00");
  expect(cron("5 9 * * 0,6").cadence).toBe("Weekends at 09:05");
  expect(cron("30 8 * * 1,3").cadence).toBe("Mon, Wed at 08:30");
  expect(cron("*/5 * * * *").cadence).toBe("*/5 * * * *");
  expect(cron("0 9 1 * *").cadence).toBe("0 9 1 * *");
  expect(describeSpec("not json")).toMatchObject({ kind: "other", cadence: "not json" });
  expect(describeSpec('{"kind":"watch","url":"https://x.test","everyMinutes":120}').cadence).toBe(
    "Watch every 2 h",
  );
  const now = 1_000_000_000_000;
  expect(until(now + 30_000, now)).toBe("due");
  expect(until(now + 90 * 60_000, now)).toBe("in 1 h");
  expect(until(now + 49 * 3_600_000, now)).toBe("in 2 d");
});
