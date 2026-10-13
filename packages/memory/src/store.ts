import { Context, Effect, Layer } from "effect";
import type { StoreError } from "./errors.ts";
import type { Message, Node, PersistedViews } from "./types.ts";

/**
 * Where the log lives. Append only: messages and nodes are written once and never edited. Only
 * the views are overwritten, and they are kept so the next process loads them instead of
 * rebuilding them (a rebuilt view differs from the live one, and every cache entry dies).
 *
 * One process owns a chat; a store need not lock.
 */
export class Store extends Context.Service<
  Store,
  {
    readonly messageCount: Effect.Effect<number, StoreError>;
    appendMessage(message: Message): Effect.Effect<void, StoreError>;
    getMessage(i: number): Effect.Effect<Message | undefined, StoreError>;
    putNode(node: Node): Effect.Effect<void, StoreError>;
    getNode(l: number, i: number): Effect.Effect<Node | undefined, StoreError>;
    /** The size of every built node, to restart the compactor. */
    readonly nodeSizes: Effect.Effect<Array<{ l: number; i: number; size: number }>, StoreError>;
    readonly loadViews: Effect.Effect<PersistedViews | undefined, StoreError>;
    saveViews(views: PersistedViews): Effect.Effect<void, StoreError>;
  }
>()("@mizook/memory/Store") {
  /** A store in memory, for tests and scratch use. */
  static readonly inMemory = Layer.sync(Store, () => {
    const messages: Message[] = [];
    const nodes = new Map<string, Node>();
    let views: PersistedViews | undefined;
    return Store.of({
      messageCount: Effect.sync(() => messages.length),
      appendMessage: (message) =>
        Effect.sync(() => {
          if (message.i !== messages.length)
            throw new Error(`message ${message.i} is out of order`);
          messages.push(message);
        }),
      getMessage: (i) => Effect.sync(() => messages[i]),
      putNode: (node) =>
        Effect.sync(() => {
          const key = `${node.l}:${node.i}`;
          if (!nodes.has(key)) nodes.set(key, node);
        }),
      getNode: (l, i) => Effect.sync(() => nodes.get(`${l}:${i}`)),
      nodeSizes: Effect.sync(() => [...nodes.values()].map(({ l, i, size }) => ({ l, i, size }))),
      loadViews: Effect.sync(() => views && structuredClone(views)),
      saveViews: (next) =>
        Effect.sync(() => {
          views = structuredClone(next);
        }),
    });
  });
}
