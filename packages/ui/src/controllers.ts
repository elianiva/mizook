// ui-sdk's `createXController()` hands code outside a component the instance's
// api. A controller object cannot live in the Model, so the Foldkit shape is a
// Command that calls the same api on the live instance, found by component and
// key. The call goes through the instance's own callbacks like a click would:
// the guard sees it, and the Model hears it as `ChangedUiState` with the reason
// `imperative`. Before any part of the component is mounted, the call does
// nothing, as a controller does before it attaches.
import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import { type Component, Message } from "./core.ts";
import { liveInstance } from "./internal/bind.ts";
import { UiRegistry } from "./registry.ts";

/** Calls `method(...args)` on the live instance of `component:key`. Its completion is `CompletedUiSync`, which `update` ignores. */
export const callController = Command.define("CallUiController", {
  args: {
    component: Schema.String,
    key: Schema.String,
    method: Schema.String,
    args: Schema.Array(Schema.Unknown),
  },
  messages: [Message.CompletedUiSync],
  execute: ({ component, key, method, args }) =>
    Effect.gen(function* () {
      const registry = yield* UiRegistry;
      const api = liveInstance(registry, component, key)?.api;
      const call: unknown =
        api === undefined || api === null ? undefined : Reflect.get(api, method);
      if (typeof call === "function") call.apply(api, args);
      return Message.CompletedUiSync();
    }),
});

/**
 * Commands for one component instance, for any component whose ui-sdk api has
 * the method. `call` is the general form; the rest name the common ones.
 * Which methods exist is the primitive's `api` (`open`, `close`, `setValue`, `focus`).
 */
export const controllerOf = <State, Slot extends string>(
  component: Component<State, Slot>,
  state: State,
) => {
  const call = (method: string, ...args: ReadonlyArray<unknown>) =>
    callController({ component: component.name, key: component.key(state), method, args });
  return {
    call,
    open: () => call("open"),
    close: () => call("close"),
    setValue: (value: unknown) => call("setValue", value),
    focus: () => call("focus"),
  };
};
