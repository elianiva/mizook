import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { IntentEvents, stepIntent, type IntentState } from "../src/intent-lifecycle.ts";

const edit = (fireCount: number, isPastExpiry: boolean) =>
  IntentEvents.Edit({ fireCount, maxFires: 3, isPastExpiry });

test.each([
  ["armed", IntentEvents.Fire({ fireCount: 2, maxFires: 3 }), "armed"],
  ["armed", IntentEvents.Fire({ fireCount: 3, maxFires: 3 }), "done"],
  ["armed", IntentEvents.Cancel(), "cancelled"],
  ["armed", IntentEvents.Expire(), "expired"],
  ["done", IntentEvents.Cancel(), undefined],
  ["expired", IntentEvents.Fire({ fireCount: 1, maxFires: 3 }), undefined],
  ["done", edit(1, false), "armed"],
  ["expired", edit(1, false), "armed"],
  ["armed", edit(3, true), "done"],
  ["armed", edit(1, true), "expired"],
  ["cancelled", edit(1, false), "cancelled"],
] as const)("%s on %o goes to %s", async (from: IntentState, event, to) => {
  expect(await Effect.runPromise(stepIntent(from, event))).toBe(to);
});
