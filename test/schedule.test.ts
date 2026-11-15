import { expect, test } from "vite-plus/test";
import { Effect, Exit } from "effect";
import { firstFire, nextFire as nextFireEffect } from "../src/schedule.ts";
import type { Spec } from "../src/schedule.ts";

const nextFire = (spec: Spec, after: Date) => Effect.runSync(nextFireEffect(spec, after));

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

test("unusable specs fail with their reason, usable ones pass", () => {
  const now = at("2026-11-15T00:00:00Z");
  const reason = (spec: Spec) => {
    const exit = Effect.runSyncExit(firstFire(spec, now));
    return Exit.isFailure(exit) ? String(exit.cause) : undefined;
  };
  expect(reason({ kind: "once", at: "soon" })).toContain("not a date");
  expect(reason({ kind: "once", at: "2026-01-01T00:00:00Z" })).toContain("past");
  expect(reason({ kind: "cron", expr: "nope", timezone: "UTC" })).toBeTruthy();
  expect(reason({ kind: "cron", expr: "0 9 * * *", timezone: "Nowhere/City" })).toBeTruthy();
  expect(reason({ kind: "watch", url: "ftp://x", everyMinutes: 30 })).toBeTruthy();
  expect(reason({ kind: "watch", url: "https://x.y", everyMinutes: 1 })).toContain("5");
  expect(reason({ kind: "cron", expr: "0 9 * * 1", timezone: "UTC" })).toBeUndefined();
});
