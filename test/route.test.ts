import { Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import { channelOf } from "../src/route.ts";

const route = (update: unknown) => Effect.runPromise(channelOf(JSON.stringify(update)));

test("two topics of one group go to different channels; General and DMs go by chat id", async () => {
  const msg = (topic?: number) => ({
    message: { chat: { id: -1001 }, ...(topic === undefined ? {} : { message_thread_id: topic }) },
  });
  expect(await route(msg(5))).toBe("-1001:5");
  expect(await route(msg(6))).toBe("-1001:6");
  expect(await route(msg())).toBe("-1001");
  expect(await route({ callback_query: { message: msg(5).message } })).toBe("-1001:5");
  expect(await route({})).toBe("main");
});

test("a body that is not JSON is a failure, not a throw", async () => {
  expect(Exit.isFailure(await Effect.runPromiseExit(channelOf("{nope")))).toBe(true);
});
