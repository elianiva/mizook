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
import { askTools } from "./tools.ts";
import { Outbox } from "./outbox.ts";
import { Usage } from "./usage.ts";
import { State, type PendingTurn, type ThreadLine } from "./state.ts";

export type AgentError = DurableError | StoreError | StateError;

export interface Incoming {
  readonly chatId: string;
  readonly threadId: string;
  readonly text: string;
  readonly where?: string;
  readonly requestId: string;
  readonly source?: "user" | "scheduled" | "webhook" | "approval" | "test";
}

const textOf = (message: AssistantMessage | ToolResultMessage): string =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

const profileText = (profile: Profile): string =>
  [
    profile.about.trim() === "" ? "" : `About the user: ${profile.about.trim()}`,
    profile.rules.length === 0
      ? ""
      : `Rules from the user:\n${profile.rules.map((rule) => `- ${rule}`).join("\n")}`,
  ]
    .filter((part) => part !== "")
    .join("\n");

const taggedWithPlace = (incoming: Incoming): string =>
  incoming.where === undefined ? incoming.text : `[in ${incoming.where}] ${incoming.text}`;

/** A web thread is its own conversation: its turn sees that thread, and memory only when searched. */
const isWebThread = (place: string): boolean => place.startsWith("web:");

const THREAD_BYTES = 32_000;

const threadText = (lines: ReadonlyArray<ThreadLine>): string => {
  const encoder = new TextEncoder();
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines.toReversed()) {
    const entry = `${line.role}: ${line.text}`;
    bytes += encoder.encode(entry).length;
    if (bytes > THREAD_BYTES && kept.length > 0) break;
    kept.push(entry);
  }
  return kept.length === 0 ? "" : `<thread>\n${kept.toReversed().join("\n\n")}\n</thread>`;
};

const WEB_THREAD_NOTE =
  "This is a web thread. The <thread> above is everything said here; your memory of the rest of the chat is not shown. Search it with tools.memory.search only when the user refers to something outside this thread.";

const JOIN_RUNNING_TURN = "steer";
const MAX_ASK_STEPS = 8;

type IndexEntry = { readonly name: string; readonly description: string };

const MAX_SKILLS_LISTED = 40;

const skillCatalogue = (
  own: ReadonlyArray<IndexEntry>,
  global: ReadonlyArray<IndexEntry>,
): string => {
  const ownNames = new Set(own.map((skill) => skill.name));
  const skills = [
    ...own.map((skill) => ({ ...skill, label: skill.name })),
    ...global
      .filter((skill) => !ownNames.has(skill.name))
      .map((skill) => ({ ...skill, label: `${skill.name} (global)` })),
  ];
  if (skills.length === 0) return "";
  const shown = skills.slice(0, MAX_SKILLS_LISTED);
  return [
    "Skills you can read with skill_manage:",
    ...shown.map((skill) => `- ${skill.label}: ${skill.description}`),
    ...(skills.length > shown.length ? [`... and ${skills.length - shown.length} more`] : []),
  ].join("\n");
};

const intentText = (intents: ReadonlyArray<Intent>): string =>
  intents.length === 0
    ? ""
    : [
        "Standing intent the user set for a moment like this:",
        ...intents.map((intent) => `- ${intent.description}`),
        "If one applies now, act on it in your reply.",
      ].join("\n");

export class Agent extends Context.Service<
  Agent,
  {
    begin(incoming: Incoming): Effect.Effect<"started" | "folded", AgentError>;
    finish(chatId: string): Effect.Effect<string, AgentError>;
    stop(chatId: string): Effect.Effect<boolean, AgentError>;
    ask(question: string): Effect.Effect<string, AgentError>;
    /** A short name for a web thread, from its opening exchange. */
    title(chatId: string): Effect.Effect<string, AgentError>;
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
      const { main, summary } = yield* Models;
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

      const globalSkillsOrNone = host.globalSkills.index.pipe(Effect.orElseSucceed(() => []));

      const nowDate = Effect.map(DateTime.now, (n) => new Date(DateTime.toEpochMillis(n)));
      const now = Effect.map(nowDate, (date) => formatDate(date, settings.timezone));

      const ENTRIES_PAGE_SIZE = 200;

      const allEntriesOf = (conversation: Conversation) =>
        call("entries", async () => {
          const entries: EntryRecord[] = [];
          let cursor;
          do {
            const page = await conversation.entries(
              { order: "ascending" },
              ENTRIES_PAGE_SIZE,
              cursor,
              context,
            );
            entries.push(...page.items);
            cursor = page.next;
          } while (cursor);
          return entries;
        });

      const logTranscript = Effect.fnUntraced(function* (
        place: string,
        entries: readonly EntryRecord[],
      ) {
        const said = (text: string) =>
          isWebThread(place)
            ? state.say(place, "agent", text).pipe(Effect.andThen(memory.append("agent", text)))
            : memory.append("agent", text);
        for (const entry of entries) {
          const message = entry.model?.[0];
          if (entry.kind === "pi.assistant" && message?.role === "assistant") {
            yield* usage.record("turn", main.id, message.usage);
            let reply = "";
            const flush = Effect.suspend(() => {
              const text = reply.trim();
              reply = "";
              return text === "" ? Effect.void : said(text);
            });
            for (const block of message.content) {
              if (block.type === "text") reply += block.text;
              else if (block.type === "toolCall" && block.name === "send_to_user") {
                yield* flush;
                const sentToUserCountsAsReply = Array.isArray(block.arguments.messages)
                  ? block.arguments.messages.filter((m): m is string => typeof m === "string")
                  : [];
                for (const text of sentToUserCountsAsReply) {
                  yield* said(text.trim());
                }
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
        const said = taggedWithPlace(incoming);
        const running = yield* state.turn(incoming.chatId);
        if (running) {
          const conversation = yield* conversationOf(running);
          yield* memory.append("user", said);
          if (isWebThread(incoming.chatId))
            yield* state.say(incoming.chatId, "user", incoming.text);
          const submission = yield* call("submit", () =>
            conversation.submit(
              {
                type: "input",
                content: said,
                whenBusy: JOIN_RUNNING_TURN,
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

        const matchesIntents = (incoming.source ?? "user") === "user";
        const woke = matchesIntents ? yield* intents.match(incoming.text, yield* nowDate) : [];
        const isolated = isWebThread(incoming.chatId);
        const turnContext = [
          `Now: ${yield* now}`,
          profileText(yield* host.profile),
          skillCatalogue(yield* skills.index, yield* globalSkillsOrNone),
          intentText(woke),
          isolated ? WEB_THREAD_NOTE : "",
        ]
          .filter((part) => part !== "")
          .join("\n\n");
        let turnText: string;
        if (isolated) {
          const earlier = threadText(yield* state.thread(incoming.chatId));
          yield* state.say(incoming.chatId, "user", incoming.text);
          yield* memory.append("user", said);
          turnText = [earlier, turnContext, said].filter((part) => part !== "").join("\n\n");
        } else {
          turnText = (yield* memory.beginTurn(said, { context: turnContext })).text;
        }
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
        turnInputs.set(conversation.id, turnText);
        const pendingTurn: PendingTurn = {
          chatId: incoming.chatId,
          threadId: incoming.threadId,
          conversationId: conversation.id,
          requestId: incoming.requestId,
          text: said,
          submissions: [],
          logged: false,
        };
        yield* state.putTurn(pendingTurn);
        const submission = yield* call("submit", () =>
          conversation.submit(
            { type: "input", content: said, requestId: incoming.requestId },
            context,
          ),
        );
        yield* state.putTurn({
          ...pendingTurn,
          submissions: [submission.id],
        });
        return "started" as const;
      });

      const finish = Effect.fn("Agent.finish")(function* (chatId: string) {
        const first = yield* state.turn(chatId);
        if (!first)
          return yield* new DurableError({ operation: "finish", cause: `no turn for ${chatId}` });
        const conversation = yield* conversationOf(first);

        const primary = yield* call("submit", () =>
          conversation.submit(
            { type: "input", content: first.text, requestId: first.requestId },
            context,
          ),
        );
        if (!first.submissions.includes(primary.id)) {
          yield* state.putTurn({
            ...first,
            submissions: [primary.id, ...first.submissions],
          });
        }

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

        const entries = yield* allEntriesOf(conversation);
        const turn = (yield* state.turn(chatId)) ?? first;
        if (!turn.logged) {
          yield* logTranscript(chatId, entries);
          yield* state.putTurn({ ...turn, logged: true });
        }
        turnInputs.delete(conversation.id);

        let fallbackReply: string;
        if (last?.status === "done") {
          const answer = entries.find((entry) => entry.id === last.answer)?.model?.[0];
          fallbackReply = answer?.role === "assistant" ? textOf(answer).trim() : "";
        } else {
          fallbackReply = `I couldn't answer that (${last?.reason ?? "no answer"}).`;
        }
        yield* state.deleteTurn(chatId);
        const sentToUser = (yield* outbox.take(chatId)) > 0;
        return sentToUser ? "" : fallbackReply;
      });

      const stop = Effect.fn("Agent.stop")(function* (chatId: string) {
        const running = yield* state.turn(chatId);
        if (!running) return false;
        const conversation = yield* conversationOf(running);
        yield* call("abort", () => conversation.abort(context));
        return true;
      });

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
                text: `${view.text}\n\n${turnContext}\n\nAnother of the user's agents asks you a question. Answer from your memory only, and say so if you do not know.\n\n${question}`,
              },
            ],
            timestamp: Date.now(),
          },
        ];
        for (let step = 0; step < MAX_ASK_STEPS; step++) {
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
                ? yield* handlers.call(toolCall.name, toolCall.arguments, undefined)
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

      const title = Effect.fn("Agent.title")(function* (chatId: string) {
        const lines = yield* state
          .thread(chatId)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<ThreadLine> => []));
        const opening = lines
          .slice(0, 6)
          .map((line) => `${line.role}: ${line.text}`)
          .join("\n\n")
          .slice(0, 4_000);
        if (opening.trim() === "") return "";
        const reply = yield* call("title", () =>
          durable.models.completeSimple(
            summary,
            {
              systemPrompt:
                "You name conversations. Read the opening exchange and reply with a title only: short, 2 to 5 words in the conversation's language, no quotes, no ending punctuation.",
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: opening }],
                  timestamp: Date.now(),
                },
              ],
              tools: [],
            },
            { sessionId: "title" },
          ),
        );
        yield* usage.record("title", summary.id, reply.usage).pipe(Effect.ignore);
        return textOf(reply)
          .replace(/\s+/g, " ")
          .replace(/^title:\s*/i, "")
          .replace(/^["'“”‘’`\s]+|["'“”‘’`\s]+$/g, "")
          .replace(/[.!?]+$/, "")
          .trim()
          .slice(0, 60);
      });

      return Agent.of({ begin, finish, stop, ask, title, pending: state.turns });
    }),
  );
}
