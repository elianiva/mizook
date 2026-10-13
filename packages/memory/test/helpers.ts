import { Effect, Layer } from "effect";
import {
  Memory,
  type MemoryConfig,
  Store,
  Summarizer,
  type CompletionRequest,
} from "../src/index.ts";
import { CompletionError } from "../src/errors.ts";

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

/** A summarizer that keeps the first `keep` bytes of the input. `reply` can override it per request. */
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

/** Run `effect` with a memory over `store` and `model`. */
export const run = <A, E>(
  effect: Effect.Effect<A, E, Memory | Store>,
  options: {
    model: Layer.Layer<Summarizer>;
    store?: Layer.Layer<Store, any>;
    config?: Partial<MemoryConfig>;
  },
): Promise<A> => {
  const store = options.store ?? Store.inMemory;
  const memory = Memory.layer(config(options.config)).pipe(
    Layer.provideMerge(Layer.merge(store, options.model)),
  );
  return Effect.runPromise(Effect.provide(effect, memory) as Effect.Effect<A, E>);
};

/** A message of `n` bytes that is too long for a node, so it needs the model. */
export const long = (tag: string, n = 700) => `${tag} ${"x".repeat(n)}`;
