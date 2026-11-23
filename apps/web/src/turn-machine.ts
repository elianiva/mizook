import { Machine } from "foldkit/experimental";
import { to } from "foldkit/experimental/machine";
import { defineTaggedUnion } from "foldkit/schema";

import { Message } from "./message.ts";

export const TurnState = defineTaggedUnion({
  Idle: {},
  Sending: {},
  Stopping: {},
});
export type TurnState = typeof TurnState.Type;

/** What the composer is waiting on. A message is sent or a run is stopped, never both at once. */
export const turnMachine = Machine.define({
  state: TurnState,
  message: Message,
})({
  initial: TurnState.Idle(),
  shared: [
    Machine.forStates(["Sending", "Stopping"]).on({
      ClickedNewChat: to("Idle", () => ({ model: TurnState.Idle() })),
    }),
  ],
  states: {
    Idle: {
      on: {
        ClickedSend: to("Sending", () => ({ model: TurnState.Sending() })),
        ClickedStop: to("Stopping", () => ({ model: TurnState.Stopping() })),
      },
    },
    Sending: {
      on: {
        SentMessage: to("Idle", () => ({ model: TurnState.Idle() })),
        FailedSend: to("Idle", () => ({ model: TurnState.Idle() })),
      },
    },
    Stopping: {
      on: {
        Stopped: to("Idle", () => ({ model: TurnState.Idle() })),
        FailedStop: to("Idle", () => ({ model: TurnState.Idle() })),
      },
    },
  },
});
