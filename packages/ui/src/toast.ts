import { createToaster, toastRegion, type ToastOptions } from "@ui-sdk/core/toast";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const ToastItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  type: Schema.String,
  /** The label of the toast's action button, such as Undo. */
  action: Schema.optionalKey(Schema.String),
});
export type ToastItem = typeof ToastItem.Type;

// The Model owns what is on screen. ui-sdk's toaster owns the timers, hover pausing and
// swipes, so it lives outside the Model, one per key, and the app reaches it only through
// `show` and `watch`. The queue is the toaster's; the Model holds the ids it has confirmed.
export const State = Schema.Struct({ key: Schema.String, items: Schema.Array(ToastItem) });
export type State = typeof State.Type;

export const init = (state: { key: string }): State => ({ key: state.key, items: [] });

/** ui-sdk's toaster: timers, hover pause, swipes. The app creates one and owns it, like it owns `kit`. */
export type Toaster = ReturnType<typeof createToaster<string>>;
export const makeToaster = (): Toaster => createToaster<string>({ duration: 4000 });

/** Queues a toast. Returns the item to add to the Model. */
export const show = (
  toaster: Toaster,
  toast: {
    title: string;
    description: string;
    type?: string;
    action?: { label: string; onAction: () => void };
  },
): ToastItem => {
  const type = toast.type ?? "default";
  const options: ToastOptions<string> = {
    title: toast.title,
    description: toast.description,
    ...(toast.action === undefined ? {} : { action: toast.action }),
    type:
      type === "success" || type === "error" || type === "info" || type === "warning"
        ? type
        : "default",
  };
  const id = toaster(options);
  return {
    id,
    title: toast.title,
    description: toast.description,
    type,
    ...(toast.action === undefined ? {} : { action: toast.action.label }),
  };
};

/** Calls `onChange` with the ids still queued, whenever that changes. Returns the unsubscribe. */
export const watch = (
  toaster: Toaster,
  onChange: (ids: ReadonlyArray<string>) => void,
): (() => void) => {
  return toaster.subscribe(() => onChange(toaster.toasts().map((toast) => toast.id)));
};

/** The state after the toaster reports the ids still queued. */
export const synced = (state: State, ids: ReadonlyArray<string>): State => ({
  ...state,
  items: state.items.filter((item) => ids.includes(item.id)),
});

export const added = (state: State, item: ToastItem): State => ({
  ...state,
  items: [...state.items.filter((existing) => existing.id !== item.id), item],
});

type Slot = "region" | "list" | "root" | "title" | "description" | "action" | "close";

export const componentOf = (toaster: Toaster) =>
  defineComponent<State, Slot>({
    name: "toast",
    primitive: primitiveOf(toastRegion as (options: never) => unknown),
    state: State,
    key: (state) => state.key,
    options: () => ({ toaster, side: "bottom", align: "end" }),
    controlled: [],
    callbacks: {},
    // A fresh instance has not seen the toaster's queue yet, so the Model's confirmed items stand in.
    renderState: (state) => ({
      items: state.items.map((item, index) => ({
        toast: {
          id: item.id,
          title: item.title,
          description: item.description,
          type: item.type,
          ...(item.action === undefined ? {} : { action: { label: item.action } }),
          duration: 4000,
          priority: "polite",
          version: 0,
          order: index,
        },
        index,
        leaving: false,
      })),
    }),
    fold: (state) => state,
    tags: {
      region: "div",
      list: "ul",
      root: "li",
      title: "div",
      description: "div",
      action: "button",
      close: "button",
    },
    bound: ["region", "root", "action", "close"],
  });

// The render phase never touches the toaster (the Model's items stand in for it), so a spare
// one is enough to build `parts` and `update`. The app registers `componentOf(its toaster)`.
const spare = componentOf(makeToaster());
export const parts = makeParts(spare);
export const update = makeUpdate(spare);
