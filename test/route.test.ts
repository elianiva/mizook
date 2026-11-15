import { expect, test } from "vite-plus/test";
import { channelOf } from "../src/route.ts";

test("two topics of one group go to different channels; General and DMs go by chat id", () => {
  const msg = (topic?: number) => ({
    message: { chat: { id: -1001 }, ...(topic === undefined ? {} : { message_thread_id: topic }) },
  });
  expect(channelOf(msg(5))).toBe("-1001:5");
  expect(channelOf(msg(6))).toBe("-1001:6");
  expect(channelOf(msg())).toBe("-1001");
  expect(channelOf({ callback_query: { message: msg(5).message } })).toBe("-1001:5");
  expect(channelOf({})).toBe("main");
});
