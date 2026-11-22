import { Arbitrary, Clock, Duration, Effect, Layer, Schema } from "effect";
import {
  Memory,
  type MemoryConfig,
  Store,
  Summarizer,
  type CompletionRequest,
  type Kind,
} from "../src/index.ts";
import { CompletionError, type StoreError } from "../src/errors.ts";

export const inputOf = (request: CompletionRequest): string => {
  const last = request.messages.at(-1)!.parts.join("");
  const match = /<input>\n([\s\S]*?)\n<\/input>/.exec(last);
  return match?.[1] ?? "";
};

export interface FakeModel {
  requests: CompletionRequest[];
  inflight: number;
  maxInflight: number;
}

export const fakeSummarizer = (
  model: FakeModel,
  options: {
    keep?: number;
    delayMs?: number;
    reply?: (request: CompletionRequest, n: number) => string | Error | undefined;
  } = {},
) =>
  Layer.succeed(
    Summarizer,
    Summarizer.of({
      complete: (request) =>
        Effect.gen(function* () {
          const n = model.requests.push(request) - 1;
          model.inflight++;
          model.maxInflight = Math.max(model.maxInflight, model.inflight);
          yield* Effect.addFinalizer(() => Effect.void).pipe(Effect.scoped);
          if (options.delayMs) yield* Effect.sleep(options.delayMs);
          model.inflight--;
          const override = options.reply?.(request, n);
          if (override instanceof Error)
            return yield* new CompletionError({ cause: override.message });
          if (override !== undefined) return override;
          return `S(${inputOf(request)
            .slice(0, options.keep ?? 60)
            .replace(/\n/g, " ")})`;
        }),
    }),
  );

export const newModel = (): FakeModel => ({ requests: [], inflight: 0, maxInflight: 0 });

export const config = (extra: Partial<MemoryConfig> = {}): MemoryConfig => ({
  name: "Test",
  chatBudget: { hi: 2_000, lo: 1_000 },
  compactionBudget: { hi: 800, lo: 400 },
  waitFor: "5 seconds",
  ...extra,
});

export const withoutRetryPauses = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.clockWith((live) =>
    Effect.provideService(effect, Clock.Clock, {
      currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
      currentTimeMillis: live.currentTimeMillis,
      currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
      currentTimeNanos: live.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: live.monotonicTimeNanos,
      sleep: (duration) =>
        Duration.toMillis(duration) <= 1_000 ? Effect.void : live.sleep(duration),
    }),
  );

export const run = <A, E>(
  effect: Effect.Effect<A, E, Memory | Store>,
  options: {
    model: Layer.Layer<Summarizer>;
    store?: Layer.Layer<Store, StoreError>;
    config?: Partial<MemoryConfig>;
    skipRetryPauses?: boolean;
  },
): Promise<A> => {
  const store = options.store ?? Store.inMemory;
  const memory = Memory.layer(config(options.config)).pipe(
    Layer.provideMerge(Layer.merge(store, options.model)),
  );
  const provided = Effect.provide(effect, memory) as Effect.Effect<A, E | StoreError>;
  return Effect.runPromise(options.skipRetryPauses ? withoutRetryPauses(provided) : provided);
};

export const long = (tag: string, n = 700) => `${tag} ${"x".repeat(n)}`;

export const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

export const boolean = Arbitrary.schema(Schema.Boolean);

export const kind = Arbitrary.schema(
  Schema.Literals(["user", "agent", "tool", "echo", "note"] as const),
) as Arbitrary.Arbitrary<Kind>;

export const arrayOf = <A>(item: Arbitrary.Arbitrary<A>, minLength: number, maxLength: number) =>
  Arbitrary.flatMap(int(minLength, maxLength), (length) =>
    Arbitrary.array(item, { minLength: length, maxLength: length }),
  );

export const text = (maxLength: number) =>
  Arbitrary.flatMap(int(0, maxLength), (length) =>
    Arbitrary.schema(Schema.String.check(Schema.isBetweenLength(length, length))),
  );

export const storableText = (maxLength: number) =>
  Arbitrary.map(text(maxLength), (generated) => generated.replace(/\p{Cs}/gu, "\uFFFD"));

export interface Spec {
  readonly kind: Kind;
  readonly padding: number;
}

export const spec = Arbitrary.all({ kind, padding: int(0, 900) });

export const specs = (minLength: number, maxLength: number) => arrayOf(spec, minLength, maxLength);

export const textOf = (s: Spec, index: number) => `m${index} ${"x".repeat(s.padding)}`;

export const completeNodes = (messages: number) => {
  let count = 0;
  for (let size = 1; size <= messages; size *= 2) count += Math.floor(messages / size);
  return count;
};

export interface ParsedLine {
  readonly id: number;
  readonly n: number;
  readonly text: string;
}

export const parseLines = (chat: string): ParsedLine[] =>
  chat.split("\n").flatMap((line) => {
    const match = /^(\d+)\+(\d+)\|([\s\S]*)$/.exec(line);
    return match ? [{ id: Number(match[1]), n: Number(match[2]), text: match[3]! }] : [];
  });

export const chatPart = (text: string) => text.slice(0, text.indexOf("</chat>"));

export const coversInOrder = (lines: ReadonlyArray<{ id: number; n: number }>, total: number) => {
  let next = 0;
  for (const { id, n } of lines) {
    if (id !== next || n < 1) return false;
    next += n;
  }
  return next === total;
};
