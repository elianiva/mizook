import {
  createChange,
  createReorder,
  createRovingFocus,
  definePrimitive,
  type ChangeDetails,
  type ReorderDraft,
  type ReorderReason,
} from "@ui-sdk/core";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

type SortableState = { value: string[]; focused: string | null; moving: ReorderDraft | null };
type SortableOptions = {
  value?: string[];
  onValueChange?: (value: string[], details: ChangeDetails<ReorderReason>) => void;
};

// The pattern from ui-sdk's Drag and Drop docs: `createReorder` keeps the draft while an
// item moves and commits it through `onValueChange` on drop.
const sortable = definePrimitive({
  name: "sortable",
  options: { value: "list", onValueChange: "callback" },
  state: (options: SortableOptions): SortableState => ({
    value: options.value ?? [],
    focused: null,
    moving: null,
  }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  controlled: ["value"],
  api: (context) => {
    const change = createChange(context);
    return {
      roving: createRovingFocus<SortableState, { value: string }>(context, {
        slot: "item",
        key: "focused",
      }),
      reorder: createReorder<SortableState>(context, {
        slot: "item",
        key: "value",
        draft: "moving",
        preview: true,
        label: (key) => key,
        set: (value, details) => change("value", value, details),
      }),
    };
  },
  slots: (slot) => ({
    root: slot({
      attrs: () => ({ role: "listbox", "aria-roledescription": "sortable list" }),
    }),
    item: slot<{ value: string }>({
      props: { value: "string" },
      attrs: (state, part) => ({
        role: "option",
        "aria-roledescription": "sortable item",
        "aria-selected": String(part.api.reorder.moving(state, part.key)),
        tabindex: part.api.roving.tabIndex(state, part),
        "data-moving": part.api.reorder.moving(state, part.key) ? "" : undefined,
        style: "touch-action:none;user-select:none",
      }),
      on: {
        keydown: (event, { el, api, key }) =>
          api.reorder.keydown(event, key) || api.roving.keydown(event, el!),
        pointerdown: (event, { api, key }) => api.reorder.pointerdown(event, key),
      },
      bind: (el, part) => {
        const cleanups = [part.api.roving.bind(el, part), part.api.reorder.bind(el, part)];
        return () => cleanups.forEach((cleanup) => cleanup());
      },
    }),
  }),
});

const Draft = Schema.Struct({
  key: Schema.String,
  keys: Schema.Array(Schema.String),
  order: Schema.Array(Schema.String),
  pointer: Schema.Boolean,
});

export const State = Schema.Struct({
  key: Schema.String,
  /** The committed order. */
  value: Schema.Array(Schema.String),
  /** The draft while an item moves, mirrored from the instance. Null otherwise. */
  moving: Schema.NullOr(Draft),
});
export type State = typeof State.Type;

export const init = (state: { key: string; value: ReadonlyArray<string> }): State => ({
  key: state.key,
  value: state.value,
  moving: null,
});

/** The order to show: the draft's while an item moves, else the committed one. */
export const orderOf = (state: State): ReadonlyArray<string> => state.moving?.order ?? state.value;

const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const draft = Schema.decodeUnknownSync(Schema.NullOr(Draft));

type Slot = "root" | "item";

export const component = defineComponent<State, Slot>({
  name: "sortable",
  primitive: primitiveOf(sortable),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ value: [...state.value] }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  mirror: ["moving"],
  renderState: (state) => ({ moving: state.moving }),
  fold: (state, snapshot) => ({
    ...state,
    value: "value" in snapshot ? strings(snapshot["value"]) : state.value,
    moving: "moving" in snapshot ? draft(snapshot["moving"]) : state.moving,
  }),
  tags: { root: "div", item: "div" },
  bound: ["item"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
