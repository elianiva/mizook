import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord, SubmissionId } from "@earendil-works/pi-durable";
import { clipToolOutput, Memory, type StoreError } from "@mizook/memory";
import { Context, DateTime, Effect, Layer } from "effect";
import { Settings } from "./config.ts";
import { Durable } from "./durable.ts";
import { DurableError, type StateError } from "./errors.ts";
import { formatDate } from "./format.ts";
import { Handlers } from "./handlers.ts";
import { Host, type Profile } from "./host.ts";
import { Intents, type Intent } from "./intents.ts";
import { Models } from "./models.ts";
import { Skills } from "./skills.ts";
import { agentTools } from "./tools.ts";
import { Outbox } from "./outbox.ts";
import { Usage } from "./usage.ts";
import { State, type PendingTurn } from "./state.ts";

export type AgentError = DurableError | StoreError | StateError;

export interface Incoming {
  readonly chatId: string;
  /** Where the reply goes: a Chat SDK thread id. */
  readonly threadId: string;
  readonly text: string;
  /** The id of the message, so a retry finds the same submission. */
  readonly requestId: string;
  /** What started the turn. Only a user message matches standing intents. */
  readonly source?: "user" | "scheduled" | "webhook" | "approval" | "test";
}

const textOf = (message: AssistantMessage | ToolResultMessage): string =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

/** The shared profile, as one block of turn context. Empty when the user has not filled it. */
const profileText = (profile: Profile): string =>
  [
    profile.about.trim() === "" ? "" : `About the user: ${profile.about.trim()}`,
    profile.rules.length === 0
      ? ""
      : `Rules from the user:\n${profile.rules.map((rule) => `- ${rule}`).join("\n")}`,
  ]
    .filter((part) => part !== "")
    .join("\n");

/** The skill catalogue, one line each. The bodies load only when the agent reads one. */
const skillIndexText = (
  skills: ReadonlyArray<{ readonly name: string; readonly description: string }>,
): string => {
  if (skills.length === 0) return "";
  const shown = skills.slice(0, 40);
  return [
    "Skills you can read with skill_manage:",
    ...shown.map((skill) => `- ${skill.name}: ${skill.description}`),
    ...(skills.length > shown.length ? [`... and ${skills.length - shown.length} more`] : []),
  ].join("\n");
};

/** The intents this message woke, as context the user never typed. */
const intentText = (intents: ReadonlyArray<Intent>): string =>
  intents.length === 0
    ? ""
    : [
        "Standing intent the user set for a moment like this:",
        ...intents.map((intent) => `- ${intent.description}`),
        "If one applies now, act on it in your reply.",
      ].join("\n");

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
    /** Stop the chat's running turn. False when nothing is running. */
    stop(chatId: string): Effect.Effect<boolean, AgentError>;
    /**
     * Answer a question from another channel out of this chat's memory, read-only: nothing is
     * logged, and the only tools are zoom and date.
     */
    ask(question: string): Effect.Effect<string, AgentError>;
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
      const handlers = yield* Handlers;
      const usage = yield* Usage;
      const outbox = yield* Outbox;
      const host = yield* Host;
      const skills = yield* Skills;
      const intents = yield* Intents;
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

      const nowDate = Effect.map(DateTime.now, (n) => new Date(DateTime.toEpochMillis(n)));
      const now = Effect.map(nowDate, (date) => formatDate(date, settings.timezone));

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
            yield* usage.record("turn", main.id, message.usage);
            let reply = "";
            const flush = Effect.suspend(() => {
              const text = reply.trim();
              reply = "";
              return text === "" ? Effect.void : memory.append("agent", text);
            });
            for (const block of message.content) {
              if (block.type === "text") reply += block.text;
              else if (block.type === "toolCall" && block.name === "send_to_user") {
                yield* flush;
                // What the agent says to the user is its reply, whichever way it was sent.
                const said = Array.isArray(block.arguments.messages)
                  ? block.arguments.messages.filter((m): m is string => typeof m === "string")
                  : [];
                for (const text of said) yield* memory.append("agent", text.trim());
              } else if (block.type === "toolCall") {
                yield* flush;
                yield* memory.append("tool", `${block.name} ${JSON.stringify(block.arguments)}`);
              }
            }
            yield* flush;
          } else if (
            entry.kind === "pi.tool-result" &&
            message?.role === "toolResult" &&
            message.toolName !== "send_to_user"
          ) {
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

        const woke =
          (incoming.source ?? "user") === "user"
            ? yield* intents.match(incoming.text, yield* nowDate)
            : [];
        const turnContext = [
          `Now: ${yield* now}`,
          profileText(yield* host.profile),
          skillIndexText(yield* skills.index),
          intentText(woke),
        ]
          .filter((part) => part !== "")
          .join("\n\n");
        const turn = yield* memory.beginTurn(incoming.text, { context: turnContext });
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
        // The agent talks through send_to_user: its final text is only a fallback for a turn that said nothing.
        return (yield* outbox.take(chatId)) > 0 ? "" : reply;
      });

      const stop = Effect.fn("Agent.stop")(function* (chatId: string) {
        const running = yield* state.turn(chatId);
        if (!running) return false;
        const conversation = yield* conversationOf(running);
        yield* call("abort", () => conversation.abort(context));
        return true;
      });

      const askTools = agentTools.filter((tool) => tool.name === "zoom" || tool.name === "date");
      const ask = Effect.fn("Agent.ask")(function* (question: string) {
        const view = yield* memory.renderView;
        const turnContext = [`Now: ${yield* now}`, profileText(yield* host.profile)]
          .filter((part) => part !== "")
          .join("\n\n");
        const messages: Message[] = [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${view.text}\n\n${turnContext}\n\nAnother channel of the same user asks you a question. Answer from your memory only, and say so if you do not know.\n\n${question}`,
              },
            ],
            timestamp: Date.now(),
          },
        ];
        for (let step = 0; step < 8; step++) {
          const reply = yield* call("ask", () =>
            durable.models.completeSimple(
              main,
              { systemPrompt: memory.systemPrompt, messages, tools: askTools },
              { sessionId: "ask" },
            ),
          );
          yield* usage.record("ask", main.id, reply.usage);
          messages.push(reply);
          const calls = reply.content.flatMap((b) => (b.type === "toolCall" ? [b] : []));
          if (calls.length === 0) return textOf(reply).trim() || "(no answer)";
          for (const toolCall of calls) {
            const output =
              toolCall.name === "zoom" || toolCall.name === "date"
                ? yield* handlers.call(toolCall.name, toolCall.arguments)
                : `No tool ${toolCall.name} here.`;
            messages.push({
              role: "toolResult",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              content: [{ type: "text", text: output }],
              isError: false,
              timestamp: Date.now(),
            });
          }
        }
        return "(I could not settle on an answer in time.)";
      });

      return Agent.of({ begin, finish, stop, ask, pending: state.turns });
    }),
  );
}
