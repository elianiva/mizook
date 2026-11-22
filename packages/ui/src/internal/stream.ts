import { Effect, Queue, Stream } from "effect";

/** A Stream of what a listener hears while the Stream runs: the one shape every page-level module needs. */
export const fromListener = <A>(
  subscribe: (emit: (value: A) => void) => () => void,
): Stream.Stream<A> =>
  Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => subscribe((value) => Queue.offerUnsafe(queue, value))),
      (stop) => Effect.sync(stop),
    ).pipe(Effect.andThen(Effect.never)),
  );
