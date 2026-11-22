// What Date Input and Time Input share: the same slots and state around a text
// that core writes segment by segment.
import { partState } from "@ui-sdk/core/renderer";
import { Schema } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import {
  type Component,
  defineComponent,
  makeParts,
  type Parts,
  type PartsConfig,
} from "./core.ts";
import { named } from "./form-inputs.ts";
import type { PartProps, Primitive } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  /** An ISO date (`2026-11-17`) for a date input, a time (`09:30`) for a time input. Null while empty. */
  value: Schema.NullOr(Schema.String),
  granularity: Schema.String,
  locale: Schema.String,
  name: Schema.String,
  disabled: Schema.Boolean,
  readOnly: Schema.Boolean,
});
export type State = typeof State.Type;

export type Init = Readonly<{
  key: string;
  value?: string | null;
  granularity?: string;
  locale?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
}>;

export const initOf =
  (granularity: string) =>
  (state: Init): State => ({
    key: state.key,
    value: state.value ?? null,
    granularity: state.granularity ?? granularity,
    locale: state.locale ?? "en-US",
    name: state.name ?? "",
    disabled: state.disabled ?? false,
    readOnly: state.readOnly ?? false,
  });

export type Segment = Readonly<{
  key: string;
  type: string;
  text: string;
  editable: boolean;
  label: string;
}>;

type Slot = "root" | "segment" | "hidden-input";

export const componentOf = (name: string, primitive: Primitive): Component<State, Slot> =>
  defineComponent<State, Slot>({
    name,
    primitive,
    state: State,
    key: (state) => state.key,
    options: (state) => ({
      value: state.value,
      granularity: state.granularity,
      locale: state.locale,
      disabled: state.disabled,
      readOnly: state.readOnly,
      ...named(state.name),
    }),
    controlled: ["value"],
    callbacks: { onValueChange: "value" },
    fold: (state, snapshot) => ({
      ...state,
      value: typeof snapshot["value"] === "string" ? snapshot["value"] : null,
    }),
    tags: { root: "div", segment: "input", "hidden-input": "input" },
    bound: ["root", "segment"],
  });

/**
 * The segments in the locale's order, with the text each shows. They are the root slot's state,
 * so a throwaway instance reads them. This is the one read of `partState` outside `internal/render.ts`;
 * move it there (as `Rendered.state`) if render.ts gains a slot-state reader.
 */
export const segmentsOf = (
  component: Component<State, Slot>,
  state: State,
): ReadonlyArray<Segment> => {
  const instance = component.primitive({ ...component.options(state), id: state.key });
  queueMicrotask(() => instance.destroy());
  const root = partState(instance.part("root", {}, true), {}, instance.get()) as {
    segments?: ReadonlyArray<Segment>;
  };
  return (root.segments ?? []).map(({ key, type, text, editable, label }) => ({
    key,
    type,
    text,
    editable,
    label,
  }));
};

export type SegmentedParts<AppMessage> = Omit<Parts<AppMessage, Slot>, "segment"> &
  Readonly<{
    /** An input for an editable segment, a plain span for the text between segments. */
    segment: (
      props: { segment: Segment },
      attributes?: ReadonlyArray<Attribute<AppMessage>>,
      children?: ReadonlyArray<Html | string>,
    ) => Html;
  }>;

export const partsOf =
  (component: Component<State, Slot>) =>
  <AppMessage>(
    state: State,
    h: HtmlBuilder<AppMessage>,
    config: PartsConfig<AppMessage>,
  ): SegmentedParts<AppMessage> => {
    const base = makeParts(component)(state, h, config);
    return {
      ...base,
      segment: (props, attributes = [], children = []) =>
        props.segment.editable
          ? base.segment({ ...props, id: props.segment.key } as PartProps, attributes, children)
          : h.span(
              [
                ...base.attributes("segment", props as PartProps),
                h.Key(`${component.name}:${state.key}:${props.segment.key}`),
                ...attributes,
              ],
              children.length === 0 ? [props.segment.text] : children,
            ),
    };
  };
