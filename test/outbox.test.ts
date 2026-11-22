import { Arbitrary, Clock, Duration, Effect, Exit, Layer, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Outbox, typingPause } from "../src/outbox.ts";
import { State } from "../src/state.ts";
import { property } from "./property.ts";

const recordingClock = (sleeps: number[]): Clock.Clock => ({
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(() => Date.now()),
  currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => process.hrtime.bigint(),
  monotonicTimeNanos: Effect.sync(() => process.hrtime.bigint()),
  sleep: (duration) => Effect.sync(() => void sleeps.push(Duration.toMillis(duration))),
});

const withOutbox = <A, E>(f: Effect.Effect<A, E, Outbox>, sleeps: number[]) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  const layer = Outbox.layer.pipe(Layer.provide(State.layer(sql)));
  return Effect.provide(f, layer).pipe(Effect.provideService(Clock.Clock, recordingClock(sleeps)));
};

const pausedMillis = (text: string) => Math.min(1_500, 300 + 25 * text.length);

const thread = Arbitrary.schema(Schema.Literals(["a", "b", "chat:42", "é😀"]));

const bubble = Arbitrary.schema(Schema.String.check(Schema.isMaxLength(60)));

const operation = Arbitrary.all({
  kind: Arbitrary.schema(Schema.Literals(["send", "send", "take", "attach"])),
  thread,
  texts: Arbitrary.array(bubble, { maxLength: 4 }),
});

type Operation = typeof operation extends Arbitrary.Arbitrary<infer A> ? A : never;

property(
  "bubbles reach the current sink in order, the typing pauses come before every bubble but the first, and take returns and resets the per-chat count",
  Arbitrary.array(operation, { maxLength: 12 }),
  (operations: ReadonlyArray<Operation>) => {
    const sleeps: number[] = [];
    return withOutbox(
      Effect.gen(function* () {
        const outbox = yield* Outbox;
        const delivered: Array<string> = [];
        const expectedDelivered: Array<string> = [];
        const expectedSleeps: number[] = [];
        const counts = new Map<string, number>();
        let sink = 0;
        yield* outbox.attach((id, text) =>
          Effect.sync(() => void delivered.push(`0|${id}|${text}`)),
        );
        for (const { kind, thread, texts } of operations) {
          if (kind === "attach") {
            const current = ++sink;
            yield* outbox.attach((id, text) =>
              Effect.sync(() => void delivered.push(`${current}|${id}|${text}`)),
            );
          } else if (kind === "send") {
            yield* outbox.send(thread, texts);
            texts.forEach((text, index) => {
              if (index > 0) expectedSleeps.push(pausedMillis(text));
              expectedDelivered.push(`${sink}|${thread}|${text}`);
            });
            counts.set(thread, (counts.get(thread) ?? 0) + texts.length);
          } else {
            expect(yield* outbox.take(thread)).toBe(counts.get(thread) ?? 0);
            counts.delete(thread);
          }
        }
        expect(delivered).toEqual(expectedDelivered);
        expect(sleeps).toEqual(expectedSleeps);
        for (const [id, count] of counts) expect(yield* outbox.take(id)).toBe(count);
      }),
      sleeps,
    );
  },
  { runs: 25 },
);

property(
  "sending before a chat is connected fails, delivers nothing and counts nothing",
  Arbitrary.all({ thread, texts: Arbitrary.array(bubble, { minLength: 1, maxLength: 4 }) }),
  ({ thread, texts }) =>
    withOutbox(
      Effect.gen(function* () {
        const outbox = yield* Outbox;
        expect(Exit.isFailure(yield* Effect.exit(outbox.send(thread, texts)))).toBe(true);
        expect(yield* outbox.take(thread)).toBe(0);
      }),
      [],
    ),
  { runs: 20 },
);

test("a sink that opts out of pacing delivers every bubble with no typing pause", () => {
  const sleeps: number[] = [];
  const delivered: string[] = [];
  return Effect.runPromise(
    withOutbox(
      Effect.gen(function* () {
        const outbox = yield* Outbox;
        yield* outbox.attach(
          (id, text) => Effect.sync(() => void delivered.push(`${id}|${text}`)),
          {
            pace: (place) => !place.startsWith("web:"),
          },
        );
        yield* outbox.send("web:one", ["first", "second", "third"]);
        yield* outbox.send("telegram:42", ["first", "second"]);
        expect(delivered).toEqual([
          "web:one|first",
          "web:one|second",
          "web:one|third",
          "telegram:42|first",
          "telegram:42|second",
        ]);
        expect(sleeps).toEqual([pausedMillis("second")]);
        expect(yield* outbox.take("web:one")).toBe(3);
        expect(yield* outbox.take("telegram:42")).toBe(2);
      }),
      sleeps,
    ),
  );
});

property(
  "the typing pause is 300 ms plus 25 ms per character, capped at 1.5 s",
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 120 }))).pipe(
    Arbitrary.map((length) => "x".repeat(length)),
  ),
  (text) => {
    expect(Duration.toMillis(typingPause(text))).toBe(pausedMillis(text));
  },
);

property(
  "a longer bubble never gets a shorter typing pause",
  Arbitrary.all([bubble, bubble]),
  ([first, second]) => {
    const [short, long] = first.length <= second.length ? [first, second] : [second, first];
    expect(Duration.toMillis(typingPause(short))).toBeLessThanOrEqual(
      Duration.toMillis(typingPause(long)),
    );
  },
);
