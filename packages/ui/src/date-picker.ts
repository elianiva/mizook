import { datePicker } from "@ui-sdk/core/date-picker";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import type { Snapshot } from "./internal/bind.ts";
import { primitiveOf } from "./internal/render.ts";
import { popupCompletions, popupFields, popupFold } from "./popup.ts";

export { weeksOf } from "./calendar.ts";

export const State = Schema.Struct({
  ...popupFields,
  /** The chosen date as `YYYY-MM-DD`, or empty. */
  value: Schema.String,
  /** The month shown, as `YYYY-MM`. */
  month: Schema.String,
  /** What is typed in the input and not yet a date. Null shows the chosen date. */
  text: Schema.NullOr(Schema.String),
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  month: string;
  value?: string;
  open?: boolean;
}): State => ({
  key: state.key,
  open: state.open ?? false,
  mounted: state.open ?? false,
  value: state.value ?? "",
  month: state.month,
  text: null,
});

/** `YYYY-MM-DD` for ISO or `M/D/YYYY` text that names a real date, else undefined. */
export const dateOf = (text: string): string | undefined => {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  const [year, month, day] = iso !== null ? [iso[1], iso[2], iso[3]] : [us?.[3], us?.[1], us?.[2]];
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day))
    return undefined;
  return date.toISOString().slice(0, 10);
};

type Slot =
  | "root"
  | "input"
  | "trigger"
  | "content"
  | "viewport"
  | "hint"
  | "clear"
  | "preset"
  | "heading"
  | "previous"
  | "next"
  | "grid"
  | "weekdays"
  | "weekday"
  | "week"
  | "day";

export const component = defineComponent<State, Slot>({
  name: "date-picker",
  primitive: primitiveOf(datePicker),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    mode: "single",
    value: state.value === "" ? null : state.value,
    month: state.month,
    open: state.open,
    locale: "en-US",
    weekStartsOn: 0,
    showOutsideDays: true,
    fixedWeeks: true,
  }),
  controlled: ["value", "month", "open"],
  callbacks: { onValueChange: "value", onMonthChange: "month", onOpenChange: "open" },
  completions: popupCompletions,
  // The typed text is a draft the instance never saw: patch it over a fresh instance.
  renderState: (state) => ({
    mounted: state.mounted,
    ...(state.text === null
      ? {}
      : {
          drafts: [state.text, null],
          draftFor: JSON.stringify(state.value === "" ? null : state.value),
        }),
  }),
  fold: (state, snapshot: Snapshot): State => {
    const value = typeof snapshot["value"] === "string" ? snapshot["value"] : "";
    return {
      ...popupFold(state, snapshot),
      value,
      month: typeof snapshot["month"] === "string" ? snapshot["month"] : state.month,
      text: value === state.value ? state.text : null,
    };
  },
  typed: (state, text) => {
    const date = dateOf(text);
    if (date !== undefined) return { ...state, value: date, month: date.slice(0, 7), text: null };
    return text.trim() === "" ? { ...state, value: "", text: null } : { ...state, text };
  },
  text: "input",
  tags: {
    root: "div",
    input: "input",
    trigger: "button",
    content: "div",
    viewport: "div",
    hint: "div",
    clear: "button",
    preset: "button",
    heading: "div",
    previous: "button",
    next: "button",
    grid: "div",
    weekdays: "div",
    weekday: "div",
    week: "div",
    day: "button",
  },
  bound: [
    "root",
    "input",
    "trigger",
    "content",
    "hint",
    "clear",
    "preset",
    "previous",
    "next",
    "grid",
    "day",
  ],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
