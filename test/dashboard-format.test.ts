import { Arbitrary, Schema } from "effect";
import { expect } from "vite-plus/test";
import { ago, describeSpec, until } from "../apps/dashboard/src/format.ts";
import { property } from "./property.ts";

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

const oneOf = <const A extends ReadonlyArray<string>>(values: A) =>
  Arbitrary.schema(Schema.Literals(values));

const nearEdges = (minimum: number, maximum: number) =>
  Arbitrary.flatMap(int(0, 2), (pick) =>
    pick === 0
      ? int(minimum, minimum + 2)
      : pick === 1
        ? int(maximum - 2, maximum)
        : int(minimum, maximum),
  );

const now = int(1_000_000_000_000, 2_000_000_000_000);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const agoCase = Arbitrary.flatMap(oneOf(["just now", "min", "h", "d"]), (unit) => {
  if (unit === "just now")
    return Arbitrary.map(nearEdges(-10 * DAY, 59 * SECOND + 499), (elapsed) => ({
      label: "just now",
      elapsed,
    }));
  const [count, span] =
    unit === "min" ? [int(1, 59), MINUTE] : unit === "h" ? [int(1, 47), HOUR] : [int(2, 4000), DAY];
  return Arbitrary.map(
    Arbitrary.all({ n: count, into: nearEdges(-499, span - 501) }),
    ({ n, into }) => ({ label: `${n} ${unit} ago`, elapsed: n * span + into }),
  );
});

property(
  "ago names the largest whole unit elapsed, minutes from 60 s, days from 48 h, and never a future time",
  Arbitrary.all({ now, c: agoCase }),
  ({ now, c }) => {
    expect(ago(now - c.elapsed, now)).toBe(c.label);
  },
);

const untilCase = Arbitrary.flatMap(oneOf(["due", "min", "h", "d"]), (unit) => {
  if (unit === "due")
    return Arbitrary.map(nearEdges(-10 * DAY, MINUTE - 1), (ahead) => ({ label: "due", ahead }));
  const [count, span] =
    unit === "min" ? [int(1, 59), MINUTE] : unit === "h" ? [int(1, 47), HOUR] : [int(2, 4000), DAY];
  return Arbitrary.map(
    Arbitrary.all({ n: count, into: nearEdges(0, span - 1) }),
    ({ n, into }) => ({
      label: `in ${n} ${unit}`,
      ahead: n * span + into,
    }),
  );
});

property(
  "until counts whole units left, is due under a minute, and switches to days at 48 h",
  Arbitrary.all({ now, c: untilCase }),
  ({ now, c }) => {
    expect(until(now + c.ahead, now)).toBe(c.label);
  },
);

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const dayField = Arbitrary.flatMap(
  oneOf(["every", "weekdays", "weekend", "weekend-reversed", "list"]),
  (form) => {
    switch (form) {
      case "every":
        return Arbitrary.Constant({ field: "*", words: "Every day" });
      case "weekdays":
        return Arbitrary.Constant({ field: "1-5", words: "Weekdays" });
      case "weekend":
        return Arbitrary.Constant({ field: "0,6", words: "Weekends" });
      case "weekend-reversed":
        return Arbitrary.Constant({ field: "6,0", words: "Weekends" });
      default:
        return Arbitrary.map(
          Arbitrary.array(int(0, 7), { minLength: 1, maxLength: 7 }).pipe(
            Arbitrary.filter((days) => {
              const text = days.join(",");
              return text !== "0,6" && text !== "6,0";
            }),
          ),
          (days) => ({ field: days.join(","), words: days.map((d) => WEEK[d]).join(", ") }),
        );
    }
  },
);

const gap = oneOf([" ", "  ", "\t", " \t "]);

property(
  "a daily or weekly cron at a fixed time reads as days and a zero-padded clock in its own zone",
  Arbitrary.all({
    minute: int(0, 59),
    hour: int(0, 23),
    days: dayField,
    gaps: Arbitrary.all([gap, gap, gap, gap]),
    timezone: oneOf(["Asia/Jakarta", "UTC", "America/New_York", "Europe/Berlin"]),
  }),
  ({ minute, hour, days, gaps, timezone }) => {
    const fields = [String(minute), String(hour), "*", "*", days.field];
    const expr = fields.map((f, k) => (k === 0 ? f : `${gaps[k - 1]}${f}`)).join("");
    const clock = `${hour < 10 ? "0" : ""}${hour}:${minute < 10 ? "0" : ""}${minute}`;
    expect(describeSpec(JSON.stringify({ kind: "cron", expr, timezone }))).toEqual({
      kind: "cron",
      cadence: `${days.words} at ${clock}`,
      timezone,
      detail: expr,
    });
  },
);

const irregular = Arbitrary.flatMap(oneOf(["minute", "hour", "dom", "month", "dow"]), (odd) =>
  Arbitrary.map(
    Arbitrary.all({
      minute:
        odd === "minute" ? oneOf(["*/5", "*", "0-30", "1,2"]) : Arbitrary.map(int(0, 59), String),
      hour: odd === "hour" ? oneOf(["*", "*/2", "9-17"]) : Arbitrary.map(int(0, 23), String),
      dom: odd === "dom" ? Arbitrary.map(int(1, 31), String) : Arbitrary.Constant("*"),
      month: odd === "month" ? oneOf(["1", "*/3", "jan"]) : Arbitrary.Constant("*"),
      dow: odd === "dow" ? oneOf(["1-3", "mon", "*/2", "1,x"]) : oneOf(["*", "1-5", "0,6", "2"]),
    }),
    (f) => [f.minute, f.hour, f.dom, f.month, f.dow].join(" "),
  ),
);

property(
  "a cron that is not a fixed daily or weekly time reads as its own expression, in UTC when no zone is given",
  irregular,
  (expr) => {
    expect(describeSpec(JSON.stringify({ kind: "cron", expr }))).toEqual({
      kind: "cron",
      cadence: expr,
      timezone: "UTC",
      detail: expr,
    });
  },
);

property(
  "a watch reads its period in hours when it is a whole number of hours, else in minutes",
  Arbitrary.all({
    every: Arbitrary.flatMap(int(0, 1), (h) =>
      h === 0 ? int(1, 10_000) : Arbitrary.map(int(1, 200), (n) => n * 60),
    ),
    url: Arbitrary.schema(Schema.String),
  }),
  ({ every, url }) => {
    const wholeHours = every >= 60 && every % 60 === 0;
    expect(describeSpec(JSON.stringify({ kind: "watch", url, everyMinutes: every }))).toEqual({
      kind: "watch",
      cadence: `Watch every ${wholeHours ? `${every / 60} h` : `${every} min`}`,
      timezone: "UTC",
      detail: url,
    });
  },
);

property("a one-off reads as once and shows its time", Arbitrary.schema(Schema.String), (at) => {
  expect(describeSpec(JSON.stringify({ kind: "once", at }))).toEqual({
    kind: "once",
    cadence: "Once",
    timezone: "UTC",
    detail: at,
  });
});

const unrecognized = Arbitrary.flatMap(oneOf(["text", "kind", "shape", "literal"]), (form) => {
  switch (form) {
    case "text":
      return Arbitrary.map(Arbitrary.schema(Schema.String), (s) => `~${s}`);
    case "kind":
      return Arbitrary.map(
        Arbitrary.schema(Schema.String).pipe(
          Arbitrary.filter((k) => !["cron", "once", "watch"].includes(k)),
        ),
        (kind) => JSON.stringify({ kind, expr: "0 9 * * *", at: "x", url: "x" }),
      );
    case "shape":
      return oneOf([
        '{"kind":"cron","expr":5}',
        '{"kind":"once"}',
        '{"kind":"watch","url":null}',
        "{}",
      ]);
    default:
      return oneOf(["null", "1", "[]", '"cron"', "true"]);
  }
});

property(
  "a spec that is not JSON or not a known kind is shown as is, as other, in UTC",
  unrecognized,
  (json) => {
    expect(describeSpec(json)).toEqual({
      kind: "other",
      cadence: json,
      timezone: "UTC",
      detail: "",
    });
  },
);
