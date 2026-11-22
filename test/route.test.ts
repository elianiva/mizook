import { Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import { routeOf } from "../src/route.ts";

const route = (update: unknown) => Effect.runPromise(routeOf(JSON.stringify(update)));

const msg = (topic?: number, text?: string) => ({
  chat: { id: -1001 },
  ...(topic === undefined ? {} : { message_thread_id: topic, is_topic_message: true }),
  ...(text === undefined ? {} : { text }),
});

test("places are named like Chat SDK threads: one per forum topic, one per group or DM", async () => {
  expect((await route({ message: msg(5) })).place).toBe("telegram:-1001:5");
  expect((await route({ message: msg(6) })).place).toBe("telegram:-1001:6");
  expect((await route({ message: msg() })).place).toBe("telegram:-1001");
  expect((await route({ callback_query: { message: msg(5) } })).place).toBe("telegram:-1001:5");
  expect((await route({})).place).toBe("telegram:main");
});

test("a reply in a group without topics stays in the group", async () => {
  // Telegram sets message_thread_id on replies too; only a topic message names a topic.
  const reply = { chat: { id: -1001 }, message_thread_id: 77 };
  expect((await route({ message: reply })).place).toBe("telegram:-1001");
});

test("a leading command is read without its slash and bot name", async () => {
  expect((await route({ message: msg(5, "/grok is this true?") })).command).toBe("grok");
  expect((await route({ message: msg(5, "/Grok@mizook_bot hi") })).command).toBe("grok");
  expect((await route({ message: msg(5, "/stop") })).command).toBe("stop");
  expect((await route({ message: msg(5, "hello /grok") })).command).toBeUndefined();
  expect((await route({ message: msg(5, "/grokking") })).command).toBe("grokking");
});

test("an approval button names its agent, raw or wrapped by the Chat SDK", async () => {
  const press = (data: string) => route({ callback_query: { message: msg(5), data } });
  expect((await press("approve:ab12cd:7")).agentId).toBe("ab12cd");
  expect((await press(`chat:${JSON.stringify({ a: "deny:x9:12" })}`)).agentId).toBe("x9");
  expect((await press("approve:7")).agentId).toBeUndefined();
  expect((await press("chat:{broken")).agentId).toBeUndefined();
});

test("a body that is not JSON is a failure, not a throw", async () => {
  expect(Exit.isFailure(await Effect.runPromiseExit(routeOf("{nope")))).toBe(true);
});
