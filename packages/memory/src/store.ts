import { Context, Effect, Layer } from "effect";
import { StoreError } from "./errors.ts";
import type { Message, Node, PersistedViews, SearchHit, Snapshot } from "./types.ts";

const IN_MEMORY_SNIPPET_CHARS = 400;

const nodeKey = (l: number, i: number) => `${l}:${i}`;

export class Store extends Context.Service<
  Store,
  {
    readonly messageCount: Effect.Effect<number, StoreError>;
    appendMessage(message: Message): Effect.Effect<void, StoreError>;
    getMessage(i: number): Effect.Effect<Message | undefined, StoreError>;
    search(query: string, limit: number): Effect.Effect<ReadonlyArray<SearchHit>, StoreError>;
    putNode(node: Node): Effect.Effect<void, StoreError>;
    getNode(l: number, i: number): Effect.Effect<Node | undefined, StoreError>;
    readonly nodeSizes: Effect.Effect<Array<{ l: number; i: number; size: number }>, StoreError>;
    readonly loadViews: Effect.Effect<PersistedViews | undefined, StoreError>;
    saveViews(views: PersistedViews): Effect.Effect<void, StoreError>;
    readonly snapshot: Effect.Effect<Snapshot, StoreError>;
    restore(snapshot: Snapshot): Effect.Effect<void, StoreError>;
  }
>()("@mizook/memory/Store") {
  static readonly inMemory = Layer.sync(Store, () => {
    const messages: Message[] = [];
    const nodes = new Map<string, Node>();
    let views: PersistedViews | undefined;
    return Store.of({
      messageCount: Effect.sync(() => messages.length),
      appendMessage: (message) =>
        message.i === messages.length
          ? Effect.sync(() => void messages.push(message))
          : Effect.fail(
              new StoreError({
                operation: "appendMessage",
                cause: `message ${message.i} is out of order`,
              }),
            ),
      getMessage: (i) => Effect.sync(() => messages[i]),
      search: (query, limit) =>
        Effect.sync(() => {
          const needle = query.trim().toLowerCase();
          if (needle === "") return [];
          return messages
            .filter((message) => message.text.toLowerCase().includes(needle))
            .slice(0, limit)
            .map((message) => ({
              i: message.i,
              kind: message.kind,
              date: message.date,
              snippet: message.text.slice(0, IN_MEMORY_SNIPPET_CHARS),
            }));
        }),
      putNode: (node) =>
        Effect.sync(() => {
          const key = nodeKey(node.l, node.i);
          if (!nodes.has(key)) nodes.set(key, node);
        }),
      getNode: (l, i) => Effect.sync(() => nodes.get(nodeKey(l, i))),
      nodeSizes: Effect.sync(() => [...nodes.values()].map(({ l, i, size }) => ({ l, i, size }))),
      loadViews: Effect.sync(() => views && structuredClone(views)),
      saveViews: (next) =>
        Effect.sync(() => {
          views = structuredClone(next);
        }),
      snapshot: Effect.sync(() => ({
        messages: structuredClone(messages),
        nodes: structuredClone([...nodes.values()]),
        views: views && structuredClone(views),
      })),
      restore: (snapshot) =>
        messages.length > 0
          ? Effect.fail(new StoreError({ operation: "restore", cause: "the store is not empty" }))
          : Effect.sync(() => {
              messages.push(...structuredClone(snapshot.messages));
              for (const node of snapshot.nodes)
                nodes.set(nodeKey(node.l, node.i), structuredClone(node));
              views = snapshot.views && structuredClone(snapshot.views);
            }),
    });
  });
}
