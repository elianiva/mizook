export const usd = (amount: number): string => `$${amount.toFixed(amount < 1 ? 4 : 2)}`;

export const count = (value: number): string => value.toLocaleString("en-US");

/** `2026-11-01 00:12`, in UTC, from an ISO timestamp. */
export const dateTime = (iso: string): string => iso.slice(0, 16).replace("T", " ");

export const epochDateTime = (epochMs: number): string =>
  `${dateTime(new Date(epochMs).toISOString())} UTC`;

export const percent = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.round((part / whole) * 100);

/** How long ago, in the largest unit that fits: `just now`, `5 min ago`, `3 h ago`, `2 d ago`. */
export const ago = (epochMs: number, now: number = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
};

/** `in 5 min`, `in 3 h`, `in 2 d`; `due` when the time has come. */
export const until = (epochMs: number, now: number = Date.now()): string => {
  const minutes = Math.floor((epochMs - now) / 60_000);
  if (minutes < 1) {
    return "due";
  }
  if (minutes < 60) {
    return `in ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `in ${hours} h` : `in ${Math.floor(hours / 24)} d`;
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
  /** One line a person reads: `Weekdays at 19:00`. */
  readonly cadence: string;
  /** The time zone times are shown in; UTC when the spec names none. */
  readonly timezone: string;
  /** The raw cron expression, a watched URL, or nothing. */
  readonly detail: string;
}

/** Read a schedule's stored JSON for display. Anything it does not understand shows as it is. */
export const describeSpec = (json: string): SpecInfo => {
  try {
    const spec = JSON.parse(json) as Record<string, unknown>;
    if (spec["kind"] === "cron" && typeof spec["expr"] === "string") {
      const expr = spec["expr"];
      const timezone = typeof spec["timezone"] === "string" ? spec["timezone"] : "UTC";
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
  } catch {
    // fall through to the raw text
  }
  return { kind: "other", cadence: json, timezone: "UTC", detail: "" };
};

/** `Tue 17 Nov, 19:00`, in the given IANA zone. */
export const inZone = (epochMs: number, timezone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(new Date(epochMs))
      .replace(",", "");
  } catch {
    return epochDateTime(epochMs);
  }
};
