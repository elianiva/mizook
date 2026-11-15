import { expect, test } from "vite-plus/test";
import { invalid, nextFire } from "../src/schedule.ts";

const at = (s: string) => new Date(s);

test("a daily cron fires at the local hour, not the UTC hour", () => {
  const spec = { kind: "cron", expr: "0 9 * * *", timezone: "Asia/Jakarta" } as const;
  // 09:00 in Jakarta (UTC+7) is 02:00 UTC.
  expect(nextFire(spec, at("2026-11-15T01:00:00Z"))?.toISOString()).toBe(
    "2026-11-15T02:00:00.000Z",
  );
  expect(nextFire(spec, at("2026-11-15T02:00:00Z"))?.toISOString()).toBe(
    "2026-11-16T02:00:00.000Z",
  );
});

test("a cron follows daylight saving in its zone", () => {
  const spec = { kind: "cron", expr: "0 9 * * *", timezone: "America/New_York" } as const;
  expect(nextFire(spec, at("2026-03-07T00:00:00Z"))?.toISOString()).toBe(
    "2026-03-07T14:00:00.000Z",
  );
  expect(nextFire(spec, at("2026-03-09T00:00:00Z"))?.toISOString()).toBe(
    "2026-03-09T13:00:00.000Z",
  );
});

test("a missed cron asked about after now fires once, at the next slot", () => {
  const spec = { kind: "cron", expr: "*/10 * * * *", timezone: "UTC" } as const;
  // The chat slept for hours: the next slot after now is a single time.
  expect(nextFire(spec, at("2026-11-15T12:03:00Z"))?.toISOString()).toBe(
    "2026-11-15T12:10:00.000Z",
  );
});

test("a once in the past never fires; a watch is spaced by its period", () => {
  expect(nextFire({ kind: "once", at: "2026-11-15T00:00:00Z" }, at("2026-11-15T00:00:01Z"))).toBe(
    undefined,
  );
  const watch = { kind: "watch", url: "https://a.b", everyMinutes: 15 } as const;
  expect(nextFire(watch, at("2026-11-15T00:00:00Z"))?.toISOString()).toBe(
    "2026-11-15T00:15:00.000Z",
  );
});

test("invalid specs are named, valid ones pass", () => {
  const now = at("2026-11-15T00:00:00Z");
  expect(invalid({ kind: "once", at: "soon" }, now)).toContain("not a date");
  expect(invalid({ kind: "once", at: "2026-01-01T00:00:00Z" }, now)).toContain("past");
  expect(invalid({ kind: "cron", expr: "nope", timezone: "UTC" }, now)).toBeTruthy();
  expect(invalid({ kind: "cron", expr: "0 9 * * *", timezone: "Nowhere/City" }, now)).toBeTruthy();
  expect(invalid({ kind: "watch", url: "ftp://x", everyMinutes: 30 }, now)).toBeTruthy();
  expect(invalid({ kind: "watch", url: "https://x.y", everyMinutes: 1 }, now)).toContain("5");
  expect(invalid({ kind: "cron", expr: "0 9 * * 1", timezone: "UTC" }, now)).toBeUndefined();
});
