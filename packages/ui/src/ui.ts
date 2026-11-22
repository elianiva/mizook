// The aggregate. A facade over the same pieces an app can wire by hand: each
// component's `State`, `init` and `update` stay exported, and `GotUiMessage`,
// `specOf` and `syncUiState` are the same ones. `define` only does the wiring
// that was identical in every app: one Model slice, one update that folds a ui
// Message through every component, one sync Command, and one registry layer.
import { Schema } from "effect";
import { bindingOf, type Component, makeUpdate, Message, specOf, syncUiState } from "./core.ts";
import { UiRegistry } from "./registry.ts";

// `Component` is invariant in its State, so no other type admits every component.
/* oxlint-disable typescript/no-explicit-any */
type AnyComponent = Component<any, any>;
type StateOf<C> = C extends Component<infer State, any> ? State : never;
/* oxlint-enable typescript/no-explicit-any */
export type Entries = Readonly<Record<string, AnyComponent>>;
export type ModelOf<E extends Entries> = { readonly [K in keyof E]: StateOf<E[K]> };

/** The registry layer for a set of components. Hand-wired apps use it directly. */
export const layerOf = (components: ReadonlyArray<AnyComponent>, container: Element) =>
  UiRegistry.layer(
    new Map(components.map((component) => [component.name, bindingOf(component)])),
    container,
  );

export type DefineOptions<E extends Entries> = Readonly<{
  /**
   * Entries that fold their own state: `update` still folds a change into the Model, so
   * the view stays pure given the Model, but it never returns a sync for them. The
   * instance keeps what it acked, and the Model follows. An entry nobody has to
   * confirm or revert needs no Command wiring: with every entry listed here,
   * `update` returns no Commands at all. A `guard` still vetoes.
   */
  uncontrolled?: ReadonlyArray<keyof E & string>;
}>;

export const define = <const E extends Entries>(entries: E, options: DefineOptions<E> = {}) => {
  const names = Object.keys(entries) as Array<keyof E & string>;
  const synced = names.filter((name) => !options.uncontrolled?.includes(name));
  const updates = Object.fromEntries(names.map((name) => [name, makeUpdate(entries[name]!)]));

  // The one place the compiler is told what a runtime-built record holds: each
  // field is its component's own State schema.
  const Model = Schema.Struct(
    Object.fromEntries(names.map((name) => [name, entries[name]!.state])),
  ) as unknown as Schema.Codec<ModelOf<E>>;

  /**
   * Folds a ui Message through every component and returns the sync Command that
   * confirms the result into mounted instances. Compare `model` before and after
   * to react to a change, as the demo does for validation.
   */
  const update = (model: ModelOf<E>, message: Message) => {
    if (message._tag === "CompletedUiSync") {
      return { model, commands: [] as ReadonlyArray<ReturnType<typeof syncUiState>> };
    }
    const next = Object.fromEntries(
      names.map((name) => [name, updates[name]!(model[name], message)]),
    ) as ModelOf<E>;
    return {
      model: next,
      commands: (synced.length === 0
        ? []
        : [
            syncUiState({ specs: synced.map((name) => specOf(entries[name]!, next[name])) }),
          ]) as ReadonlyArray<ReturnType<typeof syncUiState>>,
    };
  };

  return {
    Model,
    update,
    /** `container` is the element the app renders into. Returns `{ layer, anchorId }`. */
    layer: (container: Element) => layerOf(Object.values(entries), container),
  };
};
