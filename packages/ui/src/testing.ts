// Test helpers. Every bound part mounts through the one `BindUiPart` definition,
// so one step resolves them all, whatever the view renders.
import { Scene } from "foldkit/test";
import { BindPart, Message } from "./core.ts";

type Sim = Parameters<ReturnType<typeof Scene.Mount.resolve>>[0];

/**
 * Resolves every pending `BindUiPart` Mount. A Scene run in Node has no DOM to
 * bind, so each one acknowledges with `CompletedUiSync`, which `update` ignores.
 * Pass the same lift the view uses (`toMessage`): Scene hands the result straight
 * to `update` without applying the view's `Mount.mapMessage`, and a Mount
 * resolver is typed with the child Message, so the cast lives here once.
 */
export const resolveBinds =
  <AppMessage>(toMessage: (message: Message) => AppMessage) =>
  (simulation: Sim): Sim =>
    simulation.mounts
      .filter((mount) => mount.name === BindPart.name)
      .reduce(
        (current) =>
          Scene.Mount.resolve(BindPart, toMessage(Message.CompletedUiSync()) as never)(current),
        simulation,
      );
