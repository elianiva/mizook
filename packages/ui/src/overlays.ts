// `@ui-sdk/core/overlays` is the registry that `toast()` and `confirm()` open into,
// and that a host renders. A Foldkit app owns what is on screen in its Model, so the
// adapter only bridges the registry into Messages: the app renders the entries.
// It does not ship a host. `confirm()` returns a promise that the host's controller
// settles, and a controller cannot sit in the Model; render a Model-owned
// `AlertDialog` for a question instead, and drive it with `controllerOf`.
import {
  overlays as sharedOverlays,
  type OverlayEntry,
  type Overlays,
} from "@ui-sdk/core/overlays";
import type { Stream } from "effect";
import { fromListener } from "./internal/stream.ts";

export { createOverlays, overlays } from "@ui-sdk/core/overlays";
export type { OverlayEntry, Overlays } from "@ui-sdk/core/overlays";

/**
 * A Stream of the registry's entries, once on subscribing and again whenever one
 * is added or removed. Marks a host as attached while it runs, so ui-sdk does not
 * warn that nothing renders `toast()`. Return it from a Subscription.
 */
export const watchOverlays = <A>(
  toMessage: (entries: ReadonlyArray<OverlayEntry>) => A,
  registry: Overlays = sharedOverlays,
): Stream.Stream<A> =>
  fromListener<A>((emit) => {
    const detach = registry.attachHost();
    const stop = registry.subscribe(() => emit(toMessage(registry.entries())));
    emit(toMessage(registry.entries()));
    return () => {
      stop();
      detach();
    };
  });
