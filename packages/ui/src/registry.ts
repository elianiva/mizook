// The registry is a Foldkit Resource, not a ManagedResource: its lifetime is the
// app's, not a Model condition. Commands `yield*` it, and the layer's finalizer
// closes it with the app's scope.
//
// Mounts cannot reach a Resource, for two reasons seen in foldkit 0.167:
//   - `Mount.define` types its requirement as Scope only, and at runtime the
//     context a Mount runs in holds Foldkit's own services (Dispatch,
//     MountTracker, Scope, ...) and none of the app's Resources.
//   - Resource layers are built lazily, on the first Command that needs one,
//     and the first render's Mounts run before that.
// So `layer(...)` creates the registry eagerly, when it is called, and records it
// on an element under a symbol. A Mount finds it by walking up from its own
// element. Foldkit replaces the container node with the view's root while the
// app runs, so the anchor is the container's parent, which stays.
//
// Several apps can share a parent. The anchor holds one registry per app id: the
// container's `id` when it has one, `app-<n>` otherwise. `layer` returns that id
// (`anchorId`), so the entry that builds the layer is also what knows it: put it
// in Flags, then the Model, and the view passes it as `PartsConfig.anchor`. The
// Mount carries it and the walk-up must match it. With no id, only a lone
// registry matches. Anything else is "no registry", and
// a Mount that finds none is loud (see `core.ts`), never silently inert.
//
// The walk stops at `body`. A bound element outside the anchor's subtree, for
// example one portaled out of it, finds nothing: see `portal.test.ts`.
import { Context, Effect, Layer, Option } from "effect";
import { type Binding, closeRegistry, makeRegistry, type Registry } from "./internal/bind.ts";

const SCOPE = Symbol.for("foldlab.ui.registries");

/** Set on an element whose Mount found no registry. Visible in a DOM dump. */
export const UNBOUND_ATTRIBUTE = "data-foldlab-unbound";

type Anchored = Map<string, Registry>;

const anchoredOn = (anchor: Element): Anchored | undefined => {
  const found: unknown = Reflect.get(anchor, SCOPE);
  return found instanceof Map ? found : undefined;
};

export class UiRegistry extends Context.Service<UiRegistry, Registry>()("foldlab/ui/Registry") {
  /**
   * `container` is the element the app renders into. Returns the Resource layer
   * and the id this app's registry is recorded under.
   */
  static readonly layer = (bindings: ReadonlyMap<string, Binding>, container: Element) => {
    // `body` is the walk's ceiling, so an app rendering into `body` anchors on it.
    const anchor =
      container === container.ownerDocument.body
        ? container
        : (container.parentElement ?? container);
    const registries: Anchored = anchoredOn(anchor) ?? new Map();
    Reflect.set(anchor, SCOPE, registries);
    // An id the container has wins. A taken one, or none, gets a counter taken
    // from what the anchor already holds, so no module-level counter exists.
    let id = container.id;
    for (let n = registries.size; id === "" || registries.has(id); n++) id = `app-${n}`;
    const registry = makeRegistry(bindings);
    registries.set(id, registry);
    const layer = Layer.effect(
      UiRegistry,
      Effect.acquireRelease(Effect.succeed(registry), () =>
        Effect.sync(() => {
          registries.delete(id);
          if (registries.size === 0) Reflect.deleteProperty(anchor, SCOPE);
          closeRegistry(registry);
        }),
      ),
    );
    return { layer, anchorId: id };
  };
}

/**
 * The registry of the app that owns `element`. `anchor` is the id the part was
 * rendered with. Empty matches only a lone registry. The walk stops at `body`.
 */
export const findRegistry = (element: Element, anchor = ""): Option.Option<Registry> => {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const registries = anchoredOn(node);
    if (registries !== undefined) {
      const found =
        anchor === ""
          ? registries.size === 1
            ? [...registries.values()][0]
            : undefined
          : registries.get(anchor);
      return Option.fromNullishOr(found);
    }
    if (node === node.ownerDocument.body) break;
  }
  return Option.none();
};
