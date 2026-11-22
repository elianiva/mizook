// A control joins a Field by taking the attributes the Field computes for its
// `control` slot. Pure: it reads a Field's parts, it binds nothing.
import type { Attribute } from "foldkit/html";
import type { PartProps } from "./internal/render.ts";

/** What a Field writes on its control: the id the label points at, the ids it is described by, validity. */
export const fieldControlAttributes = [
  "id",
  "aria-labelledby",
  "aria-describedby",
  "aria-invalid",
  "data-invalid",
] as const;

type FieldLike<AppMessage> = Readonly<{
  attributes: (
    slot: "control",
    props?: PartProps,
    only?: ReadonlyArray<string>,
  ) => ReadonlyArray<Attribute<AppMessage>>;
}>;

/**
 * The Field's attributes for its control, to pass as extra attributes to any
 * control's part: an input, a number input's control, a slider's root.
 *
 *     input.root({}, [...joinField(field)], [])
 */
export const joinField = <AppMessage>(
  field: FieldLike<AppMessage>,
  only: ReadonlyArray<string> = fieldControlAttributes,
): ReadonlyArray<Attribute<AppMessage>> => field.attributes("control", {}, only);
