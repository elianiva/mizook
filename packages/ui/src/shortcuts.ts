// Page-level keyboard shortcuts (`@ui-sdk/core/shortcuts`). A trigger's own `shortcut`
// prop is core's and needs nothing here. This is for shortcuts the app owns, like
// `mod+k` opening a command palette: a Stream for a Subscription, a Command for scopes.
import { registerShortcut, type ShortcutOptions, shortcuts } from "@ui-sdk/core/shortcuts";
import { ariaKeyshortcuts, formatShortcut } from "@ui-sdk/core/shortcuts";
import { Effect, Schema, type Stream } from "effect";
import { Command } from "foldkit";
import { Message } from "./core.ts";
import { fromListener } from "./internal/stream.ts";

export { ariaKeyshortcuts, formatShortcut, registerShortcut, shortcuts };
export type {
  ShortcutHandler,
  ShortcutInfo,
  ShortcutKeys,
  ShortcutOptions,
  Shortcuts,
} from "@ui-sdk/core/shortcuts";

/**
 * A Stream of one Message per press of `keys` ("mod+k"), registered while the
 * Stream runs. Return it from a Subscription's `dependenciesToStream`.
 */
export const shortcutStream = <A>(
  keys: string,
  toMessage: (event: KeyboardEvent) => A,
  options?: ShortcutOptions,
): Stream.Stream<A> =>
  fromListener((emit) => registerShortcut(keys, (event) => emit(toMessage(event)), options));

/**
 * `keys` formatted for a platform, with its `aria-keyshortcuts`. The view must
 * be pure, so the platform is an argument: keep `apple` in the Model, `false` at
 * first, and set it after mount from `isApple()` in `@ui-sdk/core/renderer`.
 */
export const shortcutHint = (keys: string, apple = false) => ({
  text: formatShortcut(keys, apple),
  ariaKeyshortcuts: ariaKeyshortcuts(keys, apple),
});

/** Turns a shortcut scope on or off. Its completion is `CompletedUiSync`, which `update` ignores. */
export const setShortcutScope = Command.define("SetShortcutScope", {
  args: { name: Schema.String, active: Schema.Boolean },
  messages: [Message.CompletedUiSync],
  execute: ({ name, active }) =>
    Effect.sync(() => {
      shortcuts.setScope(name, active);
      return Message.CompletedUiSync();
    }),
});
