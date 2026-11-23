import { expect, test } from "vite-plus/test";
import { Message } from "../apps/dashboard/src/message.ts";
import { PaletteState, paletteMachine } from "../apps/dashboard/src/palette-machine.ts";

const context = { resultCount: 3 };
const open = (query: string, index: number) => PaletteState.Open({ query, index });

test("the palette opens empty and closes on a second press", () => {
  const opened = paletteMachine.transition(
    PaletteState.Closed(),
    Message.PressedPalette(),
    context,
  );
  expect(opened.model).toEqual(open("", 0));
  expect(paletteMachine.transition(opened.model, Message.PressedPalette(), context).model).toEqual(
    PaletteState.Closed(),
  );
});

test("typing resets the selection and moving wraps around both ends", () => {
  const typed = paletteMachine.transition(
    open("a", 2),
    Message.TypedPaletteQuery({ value: "ab" }),
    context,
  );
  expect(typed.model).toEqual(open("ab", 0));
  const up = paletteMachine.transition(
    open("ab", 0),
    Message.MovedPaletteSelection({ by: -1 }),
    context,
  );
  expect(up.model).toEqual(open("ab", 2));
  const down = paletteMachine.transition(
    open("ab", 2),
    Message.MovedPaletteSelection({ by: 1 }),
    context,
  );
  expect(down.model).toEqual(open("ab", 0));
});

test("a closed palette ignores typing and keeps no query", () => {
  const ignored = paletteMachine.transition(
    PaletteState.Closed(),
    Message.TypedPaletteQuery({ value: "x" }),
    context,
  );
  expect(ignored.model).toEqual(PaletteState.Closed());
  expect(paletteMachine.unreachableStates()).toEqual([]);
});
