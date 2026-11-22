// Pure helpers for the forms family: the hidden inputs a form submits, a text
// control's `value`, and a control joining its Field.
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import type { Parts } from "./core.ts";

export type HiddenInputs = Readonly<{
  /** Empty means the control takes no part in a form, as in ui-sdk. */
  name: string;
  values: ReadonlyArray<string>;
  form?: string;
  disabled?: boolean;
}>;

/**
 * The hidden inputs a control adds so a native `<form>` submits it, like React's
 * `FormInputs`: one per value. Next to the control, not inside it.
 */
export const hiddenInputs = <AppMessage>(
  h: HtmlBuilder<AppMessage>,
  config: HiddenInputs,
): ReadonlyArray<Html> =>
  config.name === ""
    ? []
    : config.values.map((value, index) =>
        h.input([
          h.Key(`form-input:${config.name}:${index}`),
          h.Type("hidden"),
          h.Attribute("name", config.name),
          h.Value(value),
          ...(config.form === undefined ? [] : [h.Attribute("form", config.form)]),
          ...(config.disabled === true ? [h.Disabled(true)] : []),
        ]),
      );

/** An option bag entry for a `name` that may be empty. */
export const named = (name: string): Readonly<Record<string, string>> =>
  name === "" ? {} : { name };

/**
 * Makes one slot of a text control show `text`. Core writes no `value`, so the
 * Model's text goes in as an attribute after the slot's own.
 */
export const withText = <AppMessage, Slot extends string>(
  parts: Parts<AppMessage, Slot>,
  slot: Slot,
  h: HtmlBuilder<AppMessage>,
  text: string,
): Parts<AppMessage, Slot> => ({
  ...parts,
  [slot]: (
    props: Parameters<Parts<AppMessage, Slot>[Slot]>[0],
    attributes: ReadonlyArray<Attribute<AppMessage>> = [],
    children: ReadonlyArray<Html | string> = [],
  ) => parts[slot](props, [...attributes, h.Value(text)], children),
});
