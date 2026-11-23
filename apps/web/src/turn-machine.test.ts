import { expect, test } from "vite-plus/test";
import { Message } from "./message.ts";
import { TurnState, turnMachine } from "./turn-machine.ts";

const step = (state: TurnState, message: Message) => turnMachine.transition(state, message).model;

test("sending and stopping exclude each other and both end on a result", () => {
  const sending = step(TurnState.Idle(), Message.ClickedSend());
  expect(sending).toEqual(TurnState.Sending());
  expect(step(sending, Message.ClickedStop())).toEqual(TurnState.Sending());
  expect(step(sending, Message.FailedSend({ reason: "x" }))).toEqual(TurnState.Idle());
  const stopping = step(TurnState.Idle(), Message.ClickedStop());
  expect(step(stopping, Message.ClickedSend())).toEqual(TurnState.Stopping());
  expect(step(stopping, Message.Stopped({ ok: true }))).toEqual(TurnState.Idle());
});

test("a stray failure while idle changes nothing and a new chat resets", () => {
  expect(step(TurnState.Idle(), Message.FailedSend({ reason: "copy" }))).toEqual(TurnState.Idle());
  expect(step(TurnState.Stopping(), Message.ClickedNewChat())).toEqual(TurnState.Idle());
  expect(turnMachine.unreachableStates()).toEqual([]);
});
