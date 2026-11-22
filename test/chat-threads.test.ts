import { Effect, Layer } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { WebThreads } from "../src/chat/threads.ts";
import { Host } from "../src/host.ts";
import { fakeHost } from "./fake-host.ts";

const withThreads = <A, E>(
  f: Effect.Effect<A, E, WebThreads>,
  host: ReturnType<typeof fakeHost> = fakeHost(),
) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return Effect.provide(f, WebThreads.layer(sql).pipe(Layer.provide(Layer.succeed(Host, host))));
};

test("a transcript is kept per web place, and a later read starts after the id it was given", () =>
  Effect.runPromise(
    withThreads(
      Effect.gen(function* () {
        const threads = yield* WebThreads;
        const first = yield* threads.append("web:one", "user", "hello");
        yield* threads.append("web:one", "agent", "hi");
        const elsewhere = yield* threads.append("web:two", "user", "other");
        const all = yield* threads.messages("web:one", 0);
        const later = yield* threads.messages("web:one", first.id);

        expect(all.map((message) => [message.role, message.text])).toEqual([
          ["user", "hello"],
          ["agent", "hi"],
        ]);
        expect(all.every((message) => message.id > 0 && message.at > 0)).toBe(true);
        expect(later.map((message) => message.text)).toEqual(["hi"]);
        expect((yield* threads.messages("web:two", 0)).map((message) => message.text)).toEqual([
          "other",
        ]);
        expect(elsewhere.id).toBeGreaterThan(first.id);
      }),
    ),
  ));

test("the preview collapses whitespace to one line and stops at 160 characters", () => {
  const previews: Array<{ place: string; preview: string }> = [];
  const host = fakeHost({
    touchWebThread: (place, preview) =>
      Effect.sync(() => {
        previews.push({ place, preview });
      }),
  });
  const text = `  first\n\tsecond   ${"x".repeat(200)}  `;

  return Effect.runPromise(
    withThreads(
      Effect.gen(function* () {
        const threads = yield* WebThreads;
        yield* threads.append("web:one", "user", text);
        expect(previews).toHaveLength(1);
        expect(previews[0]!.place).toBe("web:one");
        expect(previews[0]!.preview).toBe(`first second ${"x".repeat(200)}`.slice(0, 160));
        expect(previews[0]!.preview.startsWith("  ")).toBe(false);
        expect(previews[0]!.preview.endsWith("  ")).toBe(false);
      }),
      host,
    ),
  );
});

test("the preview failing does not lose the message", () => {
  const host = fakeHost({
    touchWebThread: () => Effect.die("the hub is down"),
  });

  return Effect.runPromise(
    withThreads(
      Effect.gen(function* () {
        const threads = yield* WebThreads;
        const message = yield* threads.append("web:one", "user", "still stored");
        expect(yield* threads.messages("web:one", 0)).toEqual([message]);
      }),
      host,
    ),
  );
});

test("a read limit is clamped to at least one and at most two hundred messages", () =>
  Effect.runPromise(
    withThreads(
      Effect.gen(function* () {
        const threads = yield* WebThreads;
        yield* Effect.forEach(
          Array.from({ length: 205 }, (_, index) => index),
          (index) => threads.append("web:one", "user", `m${index}`),
          { discard: true },
        );
        expect(yield* threads.messages("web:one", 0, 0)).toHaveLength(1);
        expect(yield* threads.messages("web:one", 0, 10_000)).toHaveLength(200);
      }),
    ),
  ));
