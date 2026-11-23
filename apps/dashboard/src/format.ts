import { Effect, Option, Schema } from "effect";

/** Cents, unless the amount is below a cent and would read as zero. */
export const usd = (amount: number): string =>
  `$${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}`;

export const count = (value: number): string => value.toLocaleString("en-US");

const ISO_DATE_AND_MINUTES_LENGTH = "2026-11-01T00:12".length;

export const dateTime = (isoUtc: string): string =>
  isoUtc.slice(0, ISO_DATE_AND_MINUTES_LENGTH).replace("T", " ");

export const epochDateTime = (epochMs: number): string =>
  `${dateTime(new Date(epochMs).toISOString())} UTC`;

export const percent = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.round((part / whole) * 100);

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const HOURS_BEFORE_SHOWING_DAYS = 48;

export const ago = (epochMs: number, now: number = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - epochMs) / MS_PER_SECOND));
  if (seconds < SECONDS_PER_MINUTE) {
    return "just now";
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return hours < HOURS_BEFORE_SHOWING_DAYS
    ? `${hours} h ago`
    : `${Math.floor(hours / HOURS_PER_DAY)} d ago`;
};

export const until = (epochMs: number, now: number = Date.now()): string => {
  const minutes = Math.floor((epochMs - now) / MS_PER_MINUTE);
  if (minutes < 1) {
    return "due";
  }
  if (minutes < MINUTES_PER_HOUR) {
    return `in ${minutes} min`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return hours < HOURS_BEFORE_SHOWING_DAYS
    ? `in ${hours} h`
    : `in ${Math.floor(hours / HOURS_PER_DAY)} d`;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const clock = (minute: string, hour: string): string =>
  `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

const dayNames = (field: string): string | undefined => {
  if (field === "*") {
    return "Every day";
  }
  if (field === "1-5") {
    return "Weekdays";
  }
  if (field === "0,6" || field === "6,0") {
    return "Weekends";
  }
  const days = field.split(",").map((part) => DAYS[Number(part) % 7]);
  return days.every((day) => day !== undefined) ? days.join(", ") : undefined;
};

export interface SpecInfo {
  readonly kind: "cron" | "once" | "watch" | "other";
  readonly cadence: string;
  readonly timezone: string;
  readonly detail: string;
}

const DEFAULT_SPEC_TIMEZONE = "UTC";

const unrecognizedSpecShownAsIs = (json: string): SpecInfo => ({
  kind: "other",
  cadence: json,
  timezone: DEFAULT_SPEC_TIMEZONE,
  detail: "",
});

const SpecJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

export const describeSpec = (json: string): SpecInfo =>
  Option.match(Schema.decodeOption(SpecJson)(json), {
    onNone: () => unrecognizedSpecShownAsIs(json),
    onSome: (spec) => describeParsedSpec(json, spec),
  });

const describeParsedSpec = (json: string, spec: Readonly<Record<string, unknown>>): SpecInfo => {
  {
    if (spec["kind"] === "cron" && typeof spec["expr"] === "string") {
      const expr = spec["expr"];
      const timezone =
        typeof spec["timezone"] === "string" ? spec["timezone"] : DEFAULT_SPEC_TIMEZONE;
      const [minute, hour, dom, month, dow] = expr.split(/\s+/);
      const simple =
        minute !== undefined &&
        hour !== undefined &&
        /^\d+$/.test(minute) &&
        /^\d+$/.test(hour) &&
        dom === "*" &&
        month === "*" &&
        dow !== undefined;
      const days = simple ? dayNames(dow) : undefined;
      return {
        kind: "cron",
        cadence: simple && days !== undefined ? `${days} at ${clock(minute, hour)}` : expr,
        timezone,
        detail: expr,
      };
    }
    if (spec["kind"] === "once" && typeof spec["at"] === "string") {
      return { kind: "once", cadence: "Once", timezone: "UTC", detail: spec["at"] };
    }
    if (spec["kind"] === "watch" && typeof spec["url"] === "string") {
      const every = Number(spec["everyMinutes"]);
      return {
        kind: "watch",
        cadence: `Watch every ${every >= 60 && every % 60 === 0 ? `${every / 60} h` : `${every} min`}`,
        timezone: "UTC",
        detail: spec["url"],
      };
    }
  }
  return unrecognizedSpecShownAsIs(json);
};

export const inZone = (epochMs: number, ianaTimezone: string): string =>
  Effect.try(() =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: ianaTimezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(new Date(epochMs))
      .replace(",", ""),
  ).pipe(
    Effect.orElseSucceed(() => epochDateTime(epochMs)),
    Effect.runSync,
  );

const localParts = (epochMs: number, timeZone: string | undefined) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      ...(timeZone !== undefined && { timeZone }),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(epochMs))
      .map((part) => [part.type, part.value]),
  );

/** `2026-11-23 15:34` in the reader's own time zone, or in `timeZone` when given. */
export const localDateTime = (epochMs: number, timeZone?: string): string => {
  const p = localParts(epochMs, timeZone);
  return `${p["year"]}-${p["month"]}-${p["day"]} ${p["hour"]}:${p["minute"]}`;
};
