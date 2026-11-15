import { expect, test } from "vite-plus/test";
import { livePartial, ReplyStream, STREAM_MAX_CHARS } from "../src/stream.ts";

/** A post that records the chunks of each stream it is given. */
const recorder = () => {
  const streams: string[][] = [];
  const post = async (stream: AsyncIterable<string>) => {
    const got: string[] = [];
    streams.push(got);
    for await (const chunk of stream) got.push(chunk);
  };
  return { streams, post };
};

test("a growing answer streams as one message, and the end of the reply completes it", async () => {
  const { streams, post } = recorder();
  const stream = new ReplyStream(post);
  stream.update({ key: 7, text: "Hel" });
  stream.update({ key: 7, text: "Hello wor" });
  const rest = await stream.finish("Hello world!");
  expect(rest).toBe("");
  expect(streams).toHaveLength(1);
  expect(streams[0]!.join("")).toBe("Hello world!");
});

test("a call that wrote text before using a tool is its own message; the final answer is the next", async () => {
  const { streams, post } = recorder();
  const stream = new ReplyStream(post);
  stream.update({ key: 1, text: "Let me look that up." });
  stream.update({ key: 2, text: "It costs $5" });
  expect(await stream.finish("It costs $5.")).toBe("");
  expect(streams.map((s) => s.join(""))).toEqual(["Let me look that up.", "It costs $5."]);
});

test("a reply that is not what was streamed is posted whole; a silent turn posts the reply", async () => {
  const { streams, post } = recorder();
  const stream = new ReplyStream(post);
  stream.update({ key: 1, text: "Checking…" });
  expect(await stream.finish("Done: 42")).toBe("Done: 42");
  expect(streams[0]!.join("")).toBe("Checking…");
  expect(await new ReplyStream(post).finish("Just the reply")).toBe("Just the reply");
});

test("a reply too long for one message streams its first part and hands back the rest", async () => {
  const { streams, post } = recorder();
  const stream = new ReplyStream(post);
  const reply = "x".repeat(STREAM_MAX_CHARS + 500);
  stream.update({ key: 1, text: reply.slice(0, 1_000) });
  const rest = await stream.finish(reply);
  expect(streams[0]!.join("")).toHaveLength(STREAM_MAX_CHARS);
  expect(rest).toHaveLength(500);
});

test("a failing stream gives the whole reply back so nothing is lost", async () => {
  const stream = new ReplyStream(async (s) => {
    for await (const _ of s) return Promise.reject(new Error("telegram down"));
  });
  stream.update({ key: 1, text: "Hi" });
  expect(await stream.finish("Hi there")).toBe("Hi there");
});

test("the live partial is read from the conversation view's live document", () => {
  const view = (docs: object, ids: number[]) =>
    ({ docs, entries: ids.map((id) => ({ id })) }) as never;
  const live = {
    generation: {
      attempt: 1,
      message: {
        content: [
          { type: "thinking", thinking: "x" },
          { type: "text", text: "Hi " },
          { type: "text", text: "there" },
        ],
      },
    },
  };
  expect(livePartial(view({ "pi.live": live }, [3, 4]))).toEqual({ key: 4, text: "Hi there" });
  expect(livePartial(view({}, [3]))).toBeUndefined();
  expect(livePartial(view({ "pi.live": { run: {} } }, [3]))).toBeUndefined();
});
