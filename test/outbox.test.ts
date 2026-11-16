import { Duration, Effect, Exit, Layer } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Outbox, typingPause } from "../src/outbox.ts";
import { State } from "../src/state.ts";

const go = <A, E>(f: Effect.Effect<A, E, Outbox>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  const layer = Outbox.layer.pipe(Layer.provide(State.layer(sql)));
  return Effect.runPromise(Effect.provide(f, layer));
};

test("bubbles go out in order, are counted per chat, and the count resets when taken", async () => {
  await go(
    Effect.gen(function* () {
      const outbox = yield* Outbox;
      const seen: string[] = [];
      yield* outbox.attach((thread, text) =>
        Effect.sync(() => void seen.push(`${thread}:${text}`)),
      );
      yield* outbox.send("a", ["one", "two"]);
      yield* outbox.send("b", ["x"]);
      expect(seen).toEqual(["a:one", "a:two", "b:x"]);
      expect(yield* outbox.take("a")).toBe(2);
      expect(yield* outbox.take("a")).toBe(0);
      expect(yield* outbox.take("b")).toBe(1);
    }),
  );
});

test("sending before the chat is connected fails, and the typing pause grows with length but is capped", async () => {
  await go(
    Effect.gen(function* () {
      const outbox = yield* Outbox;
      expect(Exit.isFailure(yield* Effect.exit(outbox.send("a", ["hi"])))).toBe(true);
    }),
  );
  const ms = (text: string) => Duration.toMillis(typingPause(text));
  expect(ms("hi")).toBeLessThan(ms("x".repeat(40)));
  expect(ms("x".repeat(10_000))).toBe(1_500);
});
