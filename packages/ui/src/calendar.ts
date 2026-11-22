import { calendar } from "@ui-sdk/core/calendar";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import type { Snapshot } from "./internal/bind.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  /** The chosen date as `YYYY-MM-DD`, or empty. */
  value: Schema.String,
  /** The month shown, as `YYYY-MM`. */
  month: Schema.String,
});
export type State = typeof State.Type;

export const init = (state: { key: string; value?: string; month: string }): State => ({
  key: state.key,
  value: state.value ?? "",
  month: state.month,
});

const two = (n: number) => String(n).padStart(2, "0");

/** The six weeks of a month, Sunday first, as `YYYY-MM-DD` strings. Pure, no Date locale. */
export const weeksOf = (month: string): ReadonlyArray<ReadonlyArray<string>> => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const start = Date.UTC(y, m - 1, 1 - first.getUTCDay());
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => {
      const d = new Date(start + (week * 7 + day) * 86_400_000);
      return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
    }),
  );
};

type Slot =
  | "root"
  | "heading"
  | "previous"
  | "next"
  | "grid"
  | "weekdays"
  | "weekday"
  | "week"
  | "day";

export const component = defineComponent<State, Slot>({
  name: "calendar",
  primitive: primitiveOf(calendar),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    mode: "single",
    value: state.value === "" ? null : state.value,
    month: state.month,
    locale: "en-US",
    weekStartsOn: 0,
    showOutsideDays: true,
    fixedWeeks: true,
    deselectable: false,
  }),
  controlled: ["value", "month"],
  callbacks: { onValueChange: "value", onMonthChange: "month" },
  fold: (state, snapshot: Snapshot): State => ({
    ...state,
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : "",
    month: typeof snapshot["month"] === "string" ? snapshot["month"] : state.month,
  }),
  tags: {
    root: "div",
    heading: "div",
    previous: "button",
    next: "button",
    grid: "div",
    weekdays: "div",
    weekday: "div",
    week: "div",
    day: "button",
  },
  bound: ["root", "previous", "next", "grid", "day"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
