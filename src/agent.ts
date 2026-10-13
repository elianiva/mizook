import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord, SubmissionId } from "@earendil-works/pi-durable";
import { clipToolOutput, Memory, type StoreError } from "@mizook/memory";
import { Context, DateTime, Effect, Layer } from "effect";
import { Settings } from "./config.ts";
import { Durable } from "./durable.ts";
import { DurableError, type StateError } from "./errors.ts";
import { formatDate } from "./format.ts";
import { Models } from "./models.ts";
import { State, type PendingTurn } from "./state.ts";

export type AgentError = DurableError | StoreError | StateError;

export interface Incoming {
  readonly chatId: string;
  /** Where the reply goes: a Chat SDK thread id. */
  readonly threadId: string;
  readonly text: string;
  /** The id of the message, so a retry finds the same submission. */
  readonly requestId: string;
}

const textOf = (message: AssistantMessage | ToolResultMessage): string =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

/** The agent: one turn per user message, on pi-durable, with the memory as its only continuity. */
export class Agent extends Context.Service<
  Agent,
  {
    /**
     * Start a turn for a message, or fold it into the turn already running for that chat, between
     * its tool calls. Nothing is answered here: `finish` waits for the answer.
     */
    begin(incoming: Incoming): Effect.Effect<"started" | "folded", AgentError>;
    /** Wait for the chat's turn to be answered, log it in the memory, and give the reply to post. */
    finish(chatId: string): Effect.Effect<string, AgentError>;
    /** Turns that were started and not delivered: after a restart, these are finished again. */
    readonly pending: Effect.Effect<ReadonlyArray<PendingTurn>, AgentError>;
  }
>()("mizook/Agent") {
  static readonly layer = Layer.effect(
    Agent,
    Effect.gen(function* () {
      const memory = yield* Memory;
      const state = yield* State;
      const settings = yield* Settings;
      const durable = yield* Durable;
      const { main } = yield* Models;
      const { harness, context, turnInputs } = durable;

      const call = <A>(operation: string, f: () => Promise<A>) =>
        Effect.tryPromise({ try: f, catch: (cause) => new DurableError({ operation, cause }) });

      const conversationOf = Effect.fnUntraced(function* (turn: PendingTurn) {
        const conversation = yield* call("conversation", () =>
          harness.conversation(turn.conversationId, context),
        );
        if (!conversation)
          return yield* new DurableError({
            operation: "conversation",
            cause: `conversation ${turn.conversationId} is gone`,
          });
        return conversation;
      });

      const now = Effect.gen(function* () {
        return formatDate(new Date(DateTime.toEpochMillis(yield* DateTime.now)), settings.timezone);
      });

      const entriesOf = (conversation: Conversation) =>
        call("entries", async () => {
          const entries: EntryRecord[] = [];
          let cursor;
          do {
            const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
            entries.push(...page.items);
            cursor = page.next;
          } while (cursor);
          return entries;
        });

      /** The transcript of a turn, as the memory logs it: replies, tool calls and their results. Thoughts are never logged. */
      const logTranscript = Effect.fnUntraced(function* (entries: readonly EntryRecord[]) {
        for (const entry of entries) {
          const message = entry.model?.[0];
          if (entry.kind === "pi.assistant" && message?.role === "assistant") {
            let reply = "";
            const flush = Effect.suspend(() => {
              const text = reply.trim();
              reply = "";
              return text === "" ? Effect.void : memory.append("agent", text);
            });
            for (const block of message.content) {
              if (block.type === "text") reply += block.text;
              else if (block.type === "toolCall") {
                yield* flush;
                yield* memory.append("tool", `${block.name} ${JSON.stringify(block.arguments)}`);
              }
            }
            yield* flush;
          } else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
            yield* memory.append("echo", clipToolOutput(textOf(message)));
          }
        }
      });

      const begin = Effect.fn("Agent.begin")(function* (incoming: Incoming) {
        const running = yield* state.turn(incoming.chatId);
        if (running) {
          // The user wrote while the agent works: the message reaches it between tool calls.
          const conversation = yield* conversationOf(running);
          yield* memory.append("user", incoming.text);
          const submission = yield* call("submit", () =>
            conversation.submit(
              {
                type: "input",
                content: incoming.text,
                whenBusy: "steer",
                requestId: incoming.requestId,
              },
              context,
            ),
          );
          yield* state.putTurn({
            ...running,
            submissions: [...running.submissions, submission.id],
          });
          return "folded" as const;
        }

        const turn = yield* memory.beginTurn(incoming.text, { context: `Now: ${yield* now}` });
        const conversation = yield* call("createConversation", () =>
          harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: {
                model: { provider: main.provider, modelId: main.id },
                thinkingLevel: "medium",
              },
            },
            context,
          ),
        );
        turnInputs.set(conversation.id, turn.text);
        // Record the turn before it runs: a restart then finds it and delivers its reply.
        const record: PendingTurn = {
          chatId: incoming.chatId,
          threadId: incoming.threadId,
          conversationId: conversation.id,
          requestId: incoming.requestId,
          text: incoming.text,
          submissions: [],
          logged: false,
        };
        yield* state.putTurn(record);
        const submission = yield* call("submit", () =>
          conversation.submit(
            { type: "input", content: incoming.text, requestId: incoming.requestId },
            context,
          ),
        );
        yield* state.putTurn({ ...record, submissions: [submission.id] });
        return "started" as const;
      });

      const finish = Effect.fn("Agent.finish")(function* (chatId: string) {
        const first = yield* state.turn(chatId);
        if (!first)
          return yield* new DurableError({ operation: "finish", cause: `no turn for ${chatId}` });
        const conversation = yield* conversationOf(first);

        // A turn that was recorded but not submitted before a restart: the request id finds, or makes, the submission.
        const primary = yield* call("submit", () =>
          conversation.submit(
            { type: "input", content: first.text, requestId: first.requestId },
            context,
          ),
        );
        if (!first.submissions.includes(primary.id)) {
          yield* state.putTurn({ ...first, submissions: [primary.id, ...first.submissions] });
        }

        // Wait for every submission, including those the user added while it ran.
        let waited = 0;
        let last:
          | Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof harness.submission>>>["wait"]>>
          | undefined;
        for (;;) {
          const turn = (yield* state.turn(chatId)) ?? first;
          const ids: readonly SubmissionId[] = turn.submissions;
          if (waited >= ids.length) break;
          for (const id of ids.slice(waited)) {
            const submission = yield* call("submission", () => harness.submission(id, context));
            if (submission) last = yield* call("wait", () => submission.wait(context));
          }
          waited = ids.length;
        }

        const entries = yield* entriesOf(conversation);
        const turn = (yield* state.turn(chatId)) ?? first;
        if (!turn.logged) {
          yield* logTranscript(entries);
          yield* state.putTurn({ ...turn, logged: true });
        }
        turnInputs.delete(conversation.id);

        let reply: string;
        if (last?.status === "done") {
          const answer = entries.find((entry) => entry.id === last.answer)?.model?.[0];
          reply = answer?.role === "assistant" ? textOf(answer).trim() : "";
        } else {
          reply = `I couldn't answer that (${last?.reason ?? "no answer"}).`;
        }
        yield* state.deleteTurn(chatId);
        return reply === "" ? "(no reply)" : reply;
      });

      return Agent.of({ begin, finish, pending: state.turns });
    }),
  );
}
