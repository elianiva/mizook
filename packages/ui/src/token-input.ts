import { type Token, toText, tokenInput } from "@ui-sdk/core/token-input";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { named } from "./form-inputs.ts";
import { primitiveOf } from "./internal/render.ts";

export const TokenSchema = Schema.Struct({
  type: Schema.String,
  value: Schema.String,
  label: Schema.String,
  id: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["pending", "unresolved"])),
});

/** Text and tokens, in order. */
export const Segment = Schema.Union([Schema.String, TokenSchema]);
export type Segment = typeof Segment.Type;

export const State = Schema.Struct({
  key: Schema.String,
  value: Schema.Array(Segment),
  /** What the editor shows before it binds. Core owns the editor's content after that. */
  initial: Schema.String,
  name: Schema.String,
  disabled: Schema.Boolean,
  readOnly: Schema.Boolean,
});
export type State = typeof State.Type;

const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

export const init = (state: {
  key: string;
  value?: ReadonlyArray<Segment>;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
}): State => {
  const value = state.value ?? [];
  return {
    key: state.key,
    value,
    initial: value.map((item) => escape(typeof item === "string" ? item : item.label)).join(""),
    name: state.name ?? "",
    disabled: state.disabled ?? false,
    readOnly: state.readOnly ?? false,
  };
};

/** The text a form submits for the value, with each token in the codec's form. */
export const textOf = (state: State): string =>
  toText(state.value.map((item) => (typeof item === "string" ? item : { ...item })));

const segments = Schema.decodeUnknownSync(Schema.Array(Segment));
// Core's tokens carry `data`, which is never serialized, so the Model keeps what the schema names.
const plain = (value: unknown): ReadonlyArray<Segment> =>
  segments(
    (Array.isArray(value) ? (value as ReadonlyArray<string | Token>) : []).map((item) =>
      typeof item === "string"
        ? item
        : {
            type: item.type,
            value: item.value,
            label: item.label,
            ...(item.id === undefined ? {} : { id: item.id }),
            ...(item.status === undefined ? {} : { status: item.status }),
          },
    ),
  );

type Slot = "root" | "editor";

export const component = defineComponent<State, Slot>({
  name: "token-input",
  primitive: primitiveOf(tokenInput),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    value: state.value.map((item) => (typeof item === "string" ? item : { ...item })),
    disabled: state.disabled,
    readOnly: state.readOnly,
    ...named(state.name),
  }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => ({ ...state, value: plain(snapshot["value"]) }),
  tags: { root: "div", editor: "div" },
  bound: ["root", "editor"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
