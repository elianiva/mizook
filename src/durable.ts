import { BACKGROUND_CONTEXT, type Context as ChordContext } from "@earendil-works/chord/context";
import {
  type AgentChange,
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
import type { Models as PiModels } from "@earendil-works/pi-ai/models";
import { Memory } from "@mizook/memory";
import { Context, Effect, Layer } from "effect";
import { DurableError } from "./errors.ts";
import { Models } from "./models.ts";
import { Handlers } from "./handlers.ts";
import { Self } from "./host.ts";
import { State } from "./state.ts";
import { runProgram } from "./codemode.ts";
import { agentTools } from "./tools.ts";

const STREAM_TIMEOUT_MS = 180_000;
const MAX_MODEL_RETRIES = 3;
// A web reply streams each token as it arrives; tool output only needs to show it is moving.
const ANSWER_COMMIT_INTERVAL_MS = 0;
const TOOL_OUTPUT_COMMIT_INTERVAL_MS = 500;
const COMPACT_FRESH_CONVERSATIONS = false;
const NEVER_REPLAY = "unsafe";

export class Durable extends Context.Service<
  Durable,
  {
    readonly harness: Harness;
    readonly models: PiModels;
    readonly context: ChordContext;
    readonly turnInputs: Map<ConversationId, string>;
    /** What a web conversation offers the model: it answers in text, so it has no `send_to_user`. */
    readonly webModelTools: NonNullable<AgentChange["modelTools"]>;
  }
>()("mizook/Durable") {
  static readonly layer = (database: DurableObjectSqliteDatabase) =>
    Layer.effect(
      Durable,
      Effect.gen(function* () {
        const { models, main } = yield* Models;
        const memory = yield* Memory;
        const handlers = yield* Handlers;
        const state = yield* State;
        const self = yield* Self;
        const services = yield* Effect.context<never>();
        const run = Effect.runPromiseWith(services);
        const turnInputs = new Map<ConversationId, string>();

        const text = (output: string) => ({ output: [{ type: "text" as const, text: output }] });

        const placeOf = (conversationId: ConversationId) =>
          Effect.map(
            Effect.orElseSucceed(state.turns, () => []),
            (turns) => turns.find((t) => t.conversationId === conversationId)?.threadId,
          );

        const codeOf = (args: unknown) =>
          typeof args === "object" &&
          args !== null &&
          "code" in args &&
          typeof args.code === "string"
            ? args.code
            : "";

        const sendToUser = defineTool({
          name: "send_to_user",
          description: agentTools[0]!.description,
          parameters: agentTools[0]!.parameters,
          replay: "unsafe",
          execute: async (args, api) =>
            text(
              await run(
                Effect.flatMap(placeOf(api.conversationId), (place) =>
                  handlers.call("send_to_user", args, place),
                ),
              ),
            ),
        });
        const modelTools = [
          sendToUser,
          defineTool({
            name: "execute",
            description: agentTools[1]!.description,
            parameters: agentTools[1]!.parameters,
            replay: NEVER_REPLAY,
            execute: async (args, api) =>
              text(
                await run(
                  Effect.flatMap(placeOf(api.conversationId), (place) =>
                    runProgram(
                      self.tools,
                      (name, input) => handlers.run(name, input, place),
                      codeOf(args),
                    ),
                  ),
                ),
              ),
          }),
        ];

        const contentText = (content: Message["content"]): string =>
          typeof content === "string"
            ? content
            : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

        const systemPrompt = memory.systemPrompt;

        const extension = defineExtension({
          name: "memory",
          sections: [section("prompt", () => systemPrompt, { tag: false })],
          tools: modelTools,
          hooks: [
            hook(GenerationTask, {
              beforeRequest: async (request, api) => {
                const first = request.messages.findIndex((m) => m.role === "user");
                const message = request.messages[first];
                if (message?.role !== "user") return undefined;
                const viewAndUserMessage =
                  turnInputs.get(api.conversationId) ??
                  (await run(
                    Effect.map(
                      memory.renderView,
                      (view) => `${view.text}\n\n${contentText(message.content)}`,
                    ),
                  ));
                const messages = request.messages.map((m, i) =>
                  i === first
                    ? { ...message, content: [{ type: "text" as const, text: viewAndUserMessage }] }
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
                    compaction: {
                      enabled: COMPACT_FRESH_CONVERSATIONS,
                    },
                    stream: { timeoutMs: STREAM_TIMEOUT_MS },
                    retry: { maxRetries: MAX_MODEL_RETRIES },
                    progress: {
                      partialIntervalMs: ANSWER_COMMIT_INTERVAL_MS,
                      outputIntervalMs: TOOL_OUTPUT_COMMIT_INTERVAL_MS,
                    },
                  },
                  onReport: (error) => console.error("pi-durable", error),
                },
                BACKGROUND_CONTEXT,
              ),
            catch: (cause) => new DurableError({ operation: "open harness", cause }),
          }),
          (harness) => Effect.promise(() => harness.close(BACKGROUND_CONTEXT)).pipe(Effect.ignore),
        );
        harness.resume();
        void main;
        return Durable.of({
          harness,
          models,
          context: BACKGROUND_CONTEXT,
          turnInputs,
          webModelTools: { remove: [sendToUser] },
        });
      }),
    );
}
