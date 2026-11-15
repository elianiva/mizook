import { BACKGROUND_CONTEXT, type Context as ChordContext } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  defineTool,
  type ConversationId,
  GenerationTask,
  Harness,
  hook,
  section,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Message } from "@earendil-works/pi-ai";
import { Memory } from "@mizook/memory";
import { Context, Effect, Layer } from "effect";
import { DurableError } from "./errors.ts";
import { Models } from "./models.ts";
import { Handlers } from "./handlers.ts";
import { toolSpecs } from "./tools.ts";

export class Durable extends Context.Service<
  Durable,
  {
    readonly harness: Harness;
    readonly context: ChordContext;
    /**
     * The view and the new message of each running turn, by conversation. The turn's own entry
     * holds only the user's words: the view is injected into the request, so it is never stored
     * a hundred kilobytes at a time. After a restart the entry is rendered afresh.
     */
    readonly turnInputs: Map<ConversationId, string>;
  }
>()("mizook/Durable") {
  /** pi-durable over the Durable Object's SQLite, with the memory's tools and system prompt. */
  static readonly layer = (database: DurableObjectSqliteDatabase) =>
    Layer.effect(
      Durable,
      Effect.gen(function* () {
        const { models, main } = yield* Models;
        const memory = yield* Memory;
        const handlers = yield* Handlers;
        const services = yield* Effect.context<never>();
        const run = Effect.runPromiseWith(services);
        const turnInputs = new Map<ConversationId, string>();

        const text = (output: string) => ({ output: [{ type: "text" as const, text: output }] });

        const tools = toolSpecs.map((spec) =>
          defineTool({
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters,
            replay: spec.replay,
            execute: async (args) => text(await run(handlers.call(spec.name, args))),
          }),
        );

        const contentText = (content: Message["content"]): string =>
          typeof content === "string"
            ? content
            : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

        const extension = defineExtension({
          name: "memory",
          // The one system prompt, for turns and compactions alike: never dates or state in it.
          sections: [section("prompt", () => memory.systemPrompt, { tag: false })],
          tools,
          hooks: [
            hook(GenerationTask, {
              beforeRequest: async (request, api) => {
                const first = request.messages.findIndex((m) => m.role === "user");
                const message = request.messages[first];
                if (message?.role !== "user") return undefined;
                const input =
                  turnInputs.get(api.conversationId) ??
                  (await run(
                    Effect.map(
                      memory.renderView,
                      (view) => `${view.text}\n\n${contentText(message.content)}`,
                    ),
                  ));
                const messages = request.messages.map((m, i) =>
                  i === first
                    ? { ...message, content: [{ type: "text" as const, text: input }] }
                    : m,
                );
                return { messages };
              },
            }),
          ],
        });

        const registry = createRegistry();
        registry.install(extension);

        const storage = yield* Effect.tryPromise({
          try: () => SqliteStorage.open(database),
          catch: (cause) => new DurableError({ operation: "open storage", cause }),
        });
        const harness = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              Harness.open(
                storage,
                {
                  models,
                  registry,
                  settings: {
                    // The memory is the continuity: every turn starts a fresh conversation, so there is nothing to compact.
                    compaction: { enabled: false },
                    stream: { timeoutMs: 180_000 },
                    retry: { maxRetries: 3 },
                    // A remote storage: commit partial answers less often.
                    progress: { partialIntervalMs: 500, outputIntervalMs: 500 },
                  },
                  onReport: (error) => console.error("pi-durable", error),
                },
                BACKGROUND_CONTEXT,
              ),
            catch: (cause) => new DurableError({ operation: "open harness", cause }),
          }),
          (harness) => Effect.promise(() => harness.close(BACKGROUND_CONTEXT)).pipe(Effect.ignore),
        );
        // Continue any run the last process left unfinished.
        harness.resume();
        void main;
        return Durable.of({ harness, context: BACKGROUND_CONTEXT, turnInputs });
      }),
    );
}
