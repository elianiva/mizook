import { Arbitrary, Effect, Exit, Schema } from "effect";
import { expect } from "vite-plus/test";
import { firstFire, nextFire as nextFireEffect, NEVER } from "../src/schedule.ts";
import type { Spec } from "../src/schedule.ts";
import { property } from "./property.ts";

const nextFire = (spec: Spec, after: Date) => Effect.runSync(nextFireEffect(spec, after));
const reason = (spec: Spec, now: Date) => {
  const exit = Effect.runSyncExit(firstFire(spec, now));
  return Exit.isFailure(exit) ? String(exit.cause) : undefined;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FROM = Date.UTC(2026, 0, 1);
const TO = Date.UTC(2030, 0, 1);

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const oneOf = <const A extends ReadonlyArray<string | number>>(values: A) =>
  Arbitrary.schema(Schema.Literals(values));

const instant = Arbitrary.all({
  minute: int(FROM / MINUTE, TO / MINUTE),
  within: Arbitrary.all({ pick: int(0, 3), any: int(0, MINUTE - 1) }).pipe(
    Arbitrary.map(({ pick, any }) => [0, 1, MINUTE - 1, any][pick]!),
  ),
}).pipe(Arbitrary.map(({ minute, within }) => minute * MINUTE + within));

const fixedZones = [
  { timezone: "UTC", offsetMinutes: 0 },
  { timezone: "Asia/Jakarta", offsetMinutes: 7 * 60 },
  { timezone: "Asia/Kolkata", offsetMinutes: 5 * 60 + 30 },
  { timezone: "Asia/Tokyo", offsetMinutes: 9 * 60 },
  { timezone: "America/Bogota", offsetMinutes: -5 * 60 },
] as const;

property(
  "a daily cron in a zone without daylight saving fires at the first local hour and minute strictly after the asked time",
  Arbitrary.all({
    zone: int(0, fixedZones.length - 1),
    hour: int(0, 23),
    minute: int(0, 59),
    after: instant,
  }),
  ({ zone, hour, minute, after }) => {
    const { timezone, offsetMinutes } = fixedZones[zone]!;
    const offset = offsetMinutes * MINUTE;
    const localDayStart = Math.floor((after + offset) / DAY) * DAY;
    const sameDay = localDayStart + hour * HOUR + minute * MINUTE - offset;
    const expected = sameDay > after ? sameDay : sameDay + DAY;
    const got = nextFire(
      { kind: "cron", expr: `${minute} ${hour} * * *`, timezone },
      new Date(after),
    );
    expect(got?.getTime()).toBe(expected);
  },
);

const newYorkClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

property(
  "a daily cron follows daylight saving: it fires on the hour of the New York clock, within a day and an hour",
  Arbitrary.all({ after: instant, hour: int(3, 22) }),
  ({ after, hour }) => {
    const got = nextFire(
      { kind: "cron", expr: `0 ${hour} * * *`, timezone: "America/New_York" },
      new Date(after),
    )!;
    const clock = Object.fromEntries(newYorkClock.formatToParts(got).map((p) => [p.type, p.value]));
    expect([Number(clock.hour), Number(clock.minute)]).toEqual([hour, 0]);
    expect(got.getTime()).toBeGreaterThan(after);
    expect(got.getTime() - after).toBeLessThanOrEqual(DAY + HOUR);
  },
);

property(
  "a cron every N minutes asked about after a long sleep fires once, at the next slot after now",
  Arbitrary.all({ every: oneOf([1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]), after: instant }),
  ({ every, after }) => {
    const step = every * MINUTE;
    const got = nextFire(
      { kind: "cron", expr: `*/${every} * * * *`, timezone: "UTC" },
      new Date(after),
    );
    expect(got?.getTime()).toBe((Math.floor(after / step) + 1) * step);
  },
);

property(
  "a weekly cron fires on its weekday at its hour, within the coming week",
  Arbitrary.all({ weekday: int(0, 6), hour: int(0, 23), now: instant }),
  ({ weekday, hour, now }) => {
    const spec = { kind: "cron", expr: `0 ${hour} * * ${weekday}`, timezone: "UTC" } as const;
    expect(reason(spec, new Date(now))).toBeUndefined();
    const got = Effect.runSync(firstFire(spec, new Date(now)));
    expect(got.getUTCDay()).toBe(weekday);
    expect(got.getUTCHours()).toBe(hour);
    expect(got.getUTCMinutes()).toBe(0);
    expect(got.getTime()).toBeGreaterThan(now);
    expect(got.getTime() - now).toBeLessThanOrEqual(7 * DAY);
  },
);

property(
  "a once fires at its time only when that time is strictly after the asked time, and is refused as past otherwise",
  Arbitrary.all({
    at: instant,
    delta: Arbitrary.all({ pick: int(0, 5), any: int(-30 * DAY, 30 * DAY) }),
  }).pipe(
    Arbitrary.map(({ at, delta: { pick, any } }) => ({
      at,
      after: at - [-1, 0, 1, -MINUTE, MINUTE, any][pick]!,
    })),
  ),
  ({ at, after }) => {
    const spec = { kind: "once", at: new Date(at).toISOString() } as const;
    const got = nextFire(spec, new Date(after));
    if (at > after) {
      expect(got?.getTime()).toBe(at);
      expect(reason(spec, new Date(after))).toBeUndefined();
    } else {
      expect(got).toBeUndefined();
      expect(reason(spec, new Date(after))).toContain("past");
    }
  },
);

property(
  "a once whose time is words, not a date, is refused as not a date",
  Arbitrary.array(oneOf(["soon", "later", "nope", "whenever", "x", "q", "zz"]), {
    minLength: 1,
    maxLength: 4,
  }),
  (words) => {
    const at = words.join(" ");
    expect(reason({ kind: "once", at }, new Date(FROM))).toContain("not a date");
  },
);

property(
  "a watch fires its period after the asked time when it polls every five minutes or more, and is refused below five",
  Arbitrary.all({
    scheme: oneOf(["http", "https"]),
    host: oneOf(["a.b", "example.com/x?y=1", "x.y"]),
    every: Arbitrary.all({ pick: int(0, 1), small: int(0, 4), big: int(5, 10_000) }).pipe(
      Arbitrary.map(({ pick, small, big }) => (pick === 0 ? small : big)),
    ),
    after: instant,
  }),
  ({ scheme, host, every, after }) => {
    const spec = { kind: "watch", url: `${scheme}://${host}`, everyMinutes: every } as const;
    if (every >= 5) {
      expect(nextFire(spec, new Date(after))?.getTime()).toBe(after + every * MINUTE);
      expect(reason(spec, new Date(after))).toBeUndefined();
    } else {
      expect(reason(spec, new Date(after))).toContain("5");
    }
  },
);

property(
  "a watch of anything but an http or https url is refused",
  Arbitrary.all({
    scheme: oneOf(["ftp://", "file://", "", "mailto:", "ws://", "HTTP//", "https:/"]),
    host: oneOf(["x", "a.b/c"]),
    every: int(5, 600),
  }),
  ({ scheme, host, every }) => {
    expect(
      reason({ kind: "watch", url: `${scheme}${host}`, everyMinutes: every }, new Date(FROM)),
    ).toBeTruthy();
  },
);

property(
  "a cron with a broken expression or an unknown zone is refused",
  Arbitrary.all({
    broken: Arbitrary.schema(Schema.Boolean),
    word: oneOf(["nope", "every day", "61 * * * *", "0 25 * * *", "* * * * * * * *"]),
    city: oneOf(["City", "Nowhere", "Atlantis"]),
  }),
  ({ broken, word, city }) => {
    const spec = broken
      ? ({ kind: "cron", expr: word, timezone: "UTC" } as const)
      : ({ kind: "cron", expr: "0 9 * * *", timezone: `Nowhere/${city}` } as const);
    expect(reason(spec, new Date(FROM))).toBeTruthy();
  },
);

property("a webhook trigger is never due by the clock, whatever the time", instant, (after) => {
  expect(nextFire({ kind: "webhook" }, new Date(after))?.getTime()).toBe(NEVER);
});
