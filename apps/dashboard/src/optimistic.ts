import { HashMap, Option } from "effect";
import { AsyncData } from "foldkit";

/**
 * Optimistic writes into a Query's cache. A write replaces the loaded value at once and
 * bumps the generation, so a fetch already in flight cannot put the old value back. The
 * caller fetches again afterwards, so the server's answer settles the value.
 */

type Plain<A> = {
  readonly data: AsyncData.AsyncData<A, string>;
  readonly generation: number;
};

type Keyed<A> = {
  readonly generation: number;
  readonly entries: HashMap.HashMap<string, Plain<A>>;
};

export const patch =
  <A>() =>
  <Q extends Plain<A>>(query: Q, change: (value: A) => A): Q =>
    Option.match(AsyncData.getData(query.data), {
      onNone: () => query,
      onSome: (value) => ({
        ...query,
        data: AsyncData.succeed<A, string>(change(value)),
        generation: query.generation + 1,
      }),
    });

export const patchKeyed =
  <A>() =>
  <Q extends Keyed<A>>(query: Q, key: string, change: (value: A) => A): Q =>
    Option.match(HashMap.get(query.entries, key), {
      onNone: () => query,
      onSome: (entry) =>
        Option.match(AsyncData.getData(entry.data), {
          onNone: () => query,
          onSome: (value) => {
            const generation = query.generation + 1;
            return {
              ...query,
              generation,
              entries: HashMap.set(query.entries, key, {
                ...entry,
                data: AsyncData.succeed<A, string>(change(value)),
                generation,
              }),
            };
          },
        }),
    });
