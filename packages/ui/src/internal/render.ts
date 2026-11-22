// Render phase. The only file that reads attributes out of ui-sdk's unstable
// renderer entry. Nothing here touches `window`, the DOM, or a counter: the
// instance is built from Model state alone, read once, and thrown away.
import type { PrimitiveInstance } from "@ui-sdk/core";
import { attrs, menuContextTrigger, present } from "@ui-sdk/core/renderer";

/** A ui-sdk primitive, seen only as "options in, instance out". */
export type Primitive = (options: Record<string, unknown>) => PrimitiveInstance;

/** The one place a typed primitive is widened. Its option types are checked in each component's `options`. */
// Returns `unknown` on purpose: some primitives (tooltip, popover) carry slot types that
// `PrimitiveInstance` rejects under `exactOptionalPropertyTypes`. See docs/upstream-notes.md.
export const primitiveOf = (primitive: (options: never) => unknown): Primitive =>
  primitive as Primitive;

export type PartProps = Readonly<Record<string, unknown>>;
export type Attrs = Readonly<Record<string, string | undefined>>;

export type Rendered = {
  readonly attrs: (slot: string, props: PartProps) => Attrs;
  readonly present: (slot: string, props: PartProps) => boolean;
};

export const renderPhase = (
  primitive: Primitive,
  options: Readonly<Record<string, unknown>>,
  // Internal state the Model knows and a fresh instance cannot, such as a
  // dialog that is closing but still mounted. The app owns which parts exist.
  patch: Readonly<Record<string, unknown>> = {},
): Rendered => {
  // Controlled options reach `store` through the primitive's own `sync`, so
  // `get()` is exactly what these options mean, with no hidden bookkeeping.
  const instance = primitive({ ...options });
  const state = { ...instance.get(), ...patch };
  // No bind ever happens, so nothing releases the instance. Drop it once the
  // view that asked for it has finished building.
  queueMicrotask(() => instance.destroy());
  return {
    attrs: (slot, props) => attrs(instance.part(slot, props, true), props, state),
    present: (slot, props) => present(instance.part(slot, props, true), props, state),
  };
};

/** A menu that also takes the `context-trigger` slot: ui-sdk makes it a feature, not a slot of `menu`. */
export const withContextTrigger =
  (primitive: Primitive): Primitive =>
  (options) => {
    const instance = primitive(options);
    (instance as unknown as { use: (feature: unknown) => void }).use(menuContextTrigger);
    return instance;
  };
