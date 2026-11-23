import { Machine } from "@typeonce/effect-machine";
import { Effect, Schema } from "effect";
import { StateError } from "./errors.ts";

export const IntentState = Schema.Literals(["armed", "done", "cancelled", "expired"]);
export type IntentState = typeof IntentState.Type;

const States = Machine.state({ states: { Armed: {}, Done: {}, Cancelled: {}, Expired: {} } });

/** What happened to an intent. The machine decides what each fact means for its state. */
export const IntentEvents = Machine.events({
  /** A message mentioned every trigger. `fireCount` already counts this firing. */
  Fire: { fireCount: Schema.Finite, maxFires: Schema.Finite },
  Cancel: {},
  Expire: {},
  /** The intent was edited. The facts are those of the edited intent. */
  Edit: { fireCount: Schema.Finite, maxFires: Schema.Finite, isPastExpiry: Schema.Boolean },
});

const IntentMachine = Machine.make({ id: "Intent", root: States, events: IntentEvents }).handle({
  initial: { target: "Armed" },
  on: {
    Edit: {
      branches: [{ target: "Done" }, { target: "Expired" }, { target: "Armed" }],
      resolve: ({ event, select }) =>
        event.fireCount >= event.maxFires
          ? select.target("Done")
          : event.isPastExpiry
            ? select.target("Expired")
            : select.target("Armed"),
    },
  },
  states: {
    Armed: {
      on: {
        Fire: {
          branches: [{ target: "Done" }, { target: "Armed" }],
          resolve: ({ event, select }) =>
            event.fireCount >= event.maxFires ? select.target("Done") : select.target("Armed"),
        },
        Cancel: { target: "Cancelled" },
        Expire: { target: "Expired" },
      },
    },
    Done: {},
    Expired: {},
    Cancelled: { on: { Edit: { stay: true } } },
  },
});

const stateTags = {
  Armed: "armed",
  Done: "done",
  Cancelled: "cancelled",
  Expired: "expired",
} as const;

const snapshotOf = (state: IntentState) =>
  Machine.decodeSnapshot(IntentMachine, {
    _tag: "MachineSnapshot",
    version: 2,
    active: [{ path: "" }, { path: state.replace(/^./, (c) => c.toUpperCase()) }],
  });

type IntentEvent = ReturnType<
  (typeof IntentEvents)[keyof typeof IntentEvents & ("Fire" | "Cancel" | "Expire" | "Edit")]
>;

/**
 * The state an intent moves to when `event` happens to it, or `undefined`
 * when its current state does not accept the event.
 */
export const stepIntent = (
  state: IntentState,
  event: IntentEvent,
): Effect.Effect<IntentState | undefined, StateError> =>
  Effect.gen(function* () {
    const from = yield* snapshotOf(state);
    if (!(yield* Machine.can(IntentMachine, from, event))) return undefined;
    const { next } = yield* Machine.plan(IntentMachine, from, event);
    return stateTags[next.state.path as keyof typeof stateTags];
  }).pipe(Effect.mapError((cause) => new StateError({ operation: "step intent", cause })));
