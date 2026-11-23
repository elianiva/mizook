import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import {
  Actions,
  Button,
  Card,
  CardText,
  Chat,
  type Message,
  type SlashCommandEvent,
  type Thread,
} from "chat";
import { clipToolOutput } from "@mizook/memory";
import { Context, Duration, Effect, Layer, Redacted, Schedule } from "effect";
import { Agent, type AgentError } from "./agent.ts";
import { applyAgentAction } from "./agent-manage.ts";
import { chunk } from "./chunk.ts";
import { Settings } from "./config.ts";
import { TelegramError, type StateError } from "./errors.ts";
import { Outbox } from "./outbox.ts";
import { Approvals, type Approval } from "./approvals.ts";
import { MEDIA_LABEL, Media } from "./media.ts";
import { Policies } from "./policies.ts";
import { Executor } from "./executor.ts";
import { Blobs } from "./blobs.ts";
import { Commands } from "./commands.ts";
import { COMMANDS } from "./command-list.ts";
import { WebChatClient } from "./chat/web-chat-client.ts";
import type { WebTurnResult } from "./chat/types.ts";
import { Host } from "./host.ts";
import { Usage } from "./usage.ts";
import { State } from "./state.ts";

export const RECOVER_AFTER_MS = 30_000;
const BURST_QUIET_BEFORE_ANSWER_MS = 1_500;
const BURST_LONGEST_WAIT_MS = 8_000;
const DAY_MS = 24 * 3_600_000;
const TYPING_REFRESH = Duration.seconds(4);
const RECEIPT_REACTION = "👀";
const MAX_EXTRACTED_MEDIA_CHARS = 12_000;
const MAX_QUOTED_CHARS = 2_000;
const LAST_TALKED_PLACE_META_KEY = "place";

const COMMAND_NAMES: ReadonlySet<string> = new Set([...COMMANDS.map((c) => c.command), "start"]);

const GREETING = (name: string) =>
  `hey, ${name} here. I remember everything said to me, so no resets. what are we doing?`;

export class Bot extends Context.Service<
  Bot,
  {
    webhook(
      request: Request,
      waitUntil: (task: Promise<unknown>) => void,
    ): Effect.Effect<Response, TelegramError>;
    readonly recover: Effect.Effect<number, AgentError | TelegramError>;
    turn(
      place: string,
      text: string,
      requestId: string,
    ): Effect.Effect<string, AgentError | StateError | TelegramError>;
    beginWebTurn(
      place: string,
      text: string,
      requestId: string,
      where: string,
      first: boolean,
    ): Effect.Effect<WebTurnResult, AgentError | StateError | TelegramError>;
    postTo(place: string, text: string): Effect.Effect<void, StateError | TelegramError>;
    approve(
      id: number,
      approved: boolean,
      always?: boolean,
    ): Effect.Effect<{ readonly resume: Effect.Effect<void> } | undefined, StateError>;
    readonly nextWake: Effect.Effect<number | undefined, AgentError | StateError>;
  }
>()("mizook/Bot") {
  static readonly layer = Layer.effect(
    Bot,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const agent = yield* Agent;
      const state = yield* State;
      const commands = yield* Commands;
      const outbox = yield* Outbox;
      const approvals = yield* Approvals;
      const policies = yield* Policies;
      const executor = yield* Executor;
      const media = yield* Media;
      const blobs = yield* Blobs;
      const usage = yield* Usage;
      const host = yield* Host;
      const webChat = yield* WebChatClient;
      const services = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(services);

      const heldChats = new Map<string, number>();
      const isOrphanOfRestart = (chatId: string) => !heldChats.has(chatId);
      const holdChat = (chatId: string) =>
        Effect.acquireRelease(
          Effect.sync(() => void heldChats.set(chatId, (heldChats.get(chatId) ?? 0) + 1)),
          () =>
            Effect.sync(() => {
              const left = (heldChats.get(chatId) ?? 1) - 1;
              if (left > 0) heldChats.set(chatId, left);
              else heldChats.delete(chatId);
            }),
        );

      const burstsByChat = new Map<string, string[]>();

      const anyUserReachesHandler: string[] = [];
      const processState = createMemoryState();
      const foldIntoRunningTurn = "concurrent";
      const telegram = createTelegramAdapter({
        botToken: Redacted.value(settings.botToken),
        secretToken: Redacted.value(settings.webhookSecret),
        userName: settings.botUsername,
        mode: "webhook",
        allowedUserIds: anyUserReachesHandler,
      });
      const chat = new Chat({
        userName: settings.botUsername,
        adapters: { telegram },
        state: processState,
        concurrency: foldIntoRunningTurn,
        logger: "warn",
      });

      const connectAdapters = () => chat.initialize();
      const isWebPlace = (place: string) => place.startsWith("web:");

      const post = (threadId: string, text: string) =>
        Effect.tryPromise({
          try: async () => {
            await connectAdapters();
            const thread = chat.thread(threadId);
            for (const part of chunk(text)) await thread.post({ markdown: part });
          },
          catch: (cause) => new TelegramError({ operation: "post", cause }),
        });

      const sourceApproval = ({ id, summary, match, created }: Approval) => ({
        id,
        summary,
        match,
        created,
      });

      const deliver = (threadId: string, text: string) =>
        isWebPlace(threadId)
          ? webChat.appendAgent(threadId, text).pipe(
              Effect.tapError((error) => Effect.logError("web bubble failed", error)),
              Effect.ignore,
            )
          : post(threadId, text);

      const postMidTurnBubbleStraightToChat = (threadId: string, text: string) =>
        deliver(threadId, text).pipe(Effect.ignore);
      yield* outbox.attach(postMidTurnBubbleStraightToChat, {
        pace: (place) => !isWebPlace(place),
      });

      const keepTyping = (threadId: string) =>
        isWebPlace(threadId)
          ? Effect.void
          : Effect.tryPromise({
              try: async () => {
                await connectAdapters();
                await chat.thread(threadId).startTyping();
              },
              catch: (cause) => new TelegramError({ operation: "typing", cause }),
            }).pipe(
              Effect.ignore,
              Effect.repeat(Schedule.spaced(TYPING_REFRESH)),
              Effect.forkScoped,
            );

      const buttonIdNamingThisAgent = (verb: string, id: number) => `${verb}:${host.self.id}:${id}`;
      const postApprovalCards = (threadId: string) =>
        Effect.gen(function* () {
          const pending = yield* approvals.unposted(threadId);
          if (isWebPlace(threadId)) {
            yield* webChat.setStatus(threadId, true, pending.map(sourceApproval));
            return;
          }
          for (const a of pending) {
            yield* Effect.tryPromise({
              try: async () => {
                await connectAdapters();
                await chat.thread(threadId).post({
                  card: Card({
                    title: "Approval needed",
                    children: [
                      CardText(a.summary),
                      Actions([
                        Button({
                          id: buttonIdNamingThisAgent("approve", a.id),
                          label: "Approve",
                          style: "primary",
                        }),
                        ...(a.match === ""
                          ? []
                          : [
                              Button({
                                id: buttonIdNamingThisAgent("always", a.id),
                                label: "Always allow",
                                style: "primary",
                              }),
                            ]),
                        Button({
                          id: buttonIdNamingThisAgent("deny", a.id),
                          label: "Deny",
                          style: "danger",
                        }),
                      ]),
                    ],
                  }),
                });
              },
              catch: (cause) => new TelegramError({ operation: "approval card", cause }),
            });
            yield* approvals.markPosted(a.id);
          }
        });

      const waitForAnswerAndPost = (
        chatId: string,
        threadId: string,
        typingStarted = false,
        renameFrom?: string,
      ) =>
        Effect.gen(function* () {
          if (!typingStarted) yield* keepTyping(threadId);
          const reply = yield* agent.finish(chatId);
          if (reply.trim() !== "") yield* deliver(threadId, reply);
          yield* postApprovalCards(threadId);
          if (isWebPlace(threadId)) {
            const pending = yield* approvals.unposted(threadId);
            yield* webChat.setStatus(threadId, false, pending.map(sourceApproval));
            if (renameFrom !== undefined) {
              const title = yield* agent
                .title(chatId)
                .pipe(Effect.catchCause(() => Effect.succeed("")));
              if (title !== "")
                yield* webChat.autoTitle(threadId, title, renameFrom).pipe(Effect.ignore);
            }
          }
          return reply;
        }).pipe(Effect.scoped);

      const tellStrangerTheirId = (threadId: string, isDM: boolean, userId: string) =>
        isDM
          ? post(threadId, `You're not allowed to use this bot. Your Telegram id is ${userId}.`)
          : Effect.void;

      const reactWithReceipt = (threadId: string, messageId: string) =>
        Effect.tryPromise({
          try: () => telegram.addReaction(threadId, messageId, RECEIPT_REACTION),
          catch: (cause) => new TelegramError({ operation: "reaction", cause }),
        }).pipe(Effect.ignore);

      const joinBurst = (place: string, first: string) => {
        const messagesInRun = [first];
        burstsByChat.set(place, messagesInRun);
        const began = Date.now();
        let countAtLastCheck = 0;
        return Effect.whileLoop({
          while: () =>
            messagesInRun.length !== countAtLastCheck && Date.now() - began < BURST_LONGEST_WAIT_MS,
          body: () => {
            countAtLastCheck = messagesInRun.length;
            return Effect.sleep(Duration.millis(BURST_QUIET_BEFORE_ANSWER_MS));
          },
          step: () => {},
        }).pipe(
          Effect.ensuring(Effect.sync(() => void burstsByChat.delete(place))),
          Effect.map(() => messagesInRun.join("\n")),
        );
      };

      const handleMessage = Effect.fn("Bot.message")(function* (thread: Thread, message: Message) {
        const userId = String(message.author.userId);
        if (message.author.isMe) return;
        if (!settings.allowedUserIds.has(userId)) {
          yield* tellStrangerTheirId(thread.id, thread.isDM, userId);
          return;
        }
        yield* reactWithReceipt(thread.id, message.id);
        const typed = message.text.trim();
        const notesOfFilesKeptInBlobStore: string[] = [];
        for (const file of message.attachments) {
          const bytes = yield* Effect.tryPromise(async () => {
            const data = file.data ?? (await file.fetchData?.());
            if (data === undefined) return undefined;
            return new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
          }).pipe(Effect.orElseSucceed(() => undefined));
          if (bytes === undefined) continue;
          const name = (file.name ?? `${file.type}-${message.id}`).replaceAll(/[^\w.-]/g, "_");
          const key = `inbox/${thread.id.replaceAll(/[^\w:-]/g, "_")}/${message.id}-${name}`;
          const stored = yield* blobs
            .put(key, bytes, { contentType: file.mimeType ?? "application/octet-stream" })
            .pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
          if (stored) {
            const note = `[attached ${file.type}: ${name}, ${file.mimeType ?? "unknown type"}, ${bytes.length} bytes, key ${key}]`;
            const extracted = yield* media
              .extract({
                bytes,
                contentType: file.mimeType ?? "application/octet-stream",
                name,
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`media ${key} failed: ${error.message}`).pipe(
                    Effect.as(undefined),
                  ),
                ),
              );
            notesOfFilesKeptInBlobStore.push(
              extracted === undefined
                ? note
                : `${note}\n${MEDIA_LABEL[extracted.kind]}:\n${clipToolOutput(extracted.text, MAX_EXTRACTED_MEDIA_CHARS)}`,
            );
          }
        }
        const replied = message.replyTo;
        const quotedSoAgentSeesWhatIsAnswered = replied
          ? `[replying to ${replied.author.userName || "an earlier message"}: ${
              replied.text.trim() === ""
                ? `${replied.attachments.length} attachment(s)`
                : clipToolOutput(replied.text.trim(), MAX_QUOTED_CHARS)
            }]`
          : "";
        const joined = [quotedSoAgentSeesWhatIsAnswered, typed, ...notesOfFilesKeptInBlobStore]
          .filter((part) => part !== "")
          .join("\n");
        if (joined === "") return;
        if (joined === "/start") {
          yield* post(thread.id, GREETING(host.self.name));
          return;
        }
        const commandReplyWithoutModel = yield* commands.run(thread.id, joined);
        if (commandReplyWithoutModel !== undefined) {
          yield* post(thread.id, commandReplyWithoutModel);
          return;
        }
        yield* converse(thread.id, joined, message.id);
      }, Effect.scoped);

      const converse = Effect.fn("Bot.converse")(function* (
        place: string,
        said: string,
        messageId: string,
      ) {
        const isTelegramRedelivery = !(yield* state.firstSeen(`${place}:${messageId}`));
        if (isTelegramRedelivery) return;
        yield* state.setMeta(LAST_TALKED_PLACE_META_KEY, place);
        let text = said;
        const runStillBeingTyped = burstsByChat.get(place);
        if (runStillBeingTyped) {
          runStillBeingTyped.push(text);
          return;
        }
        const turnIsRunningSoMessageFoldsIntoIt = yield* state.turn(place);
        if (!turnIsRunningSoMessageFoldsIntoIt) {
          text = yield* joinBurst(place, text);
        }
        if (settings.budgetDaily > 0) {
          const spent = yield* usage.spentSince(Date.now() - DAY_MS);
          if (spent >= settings.budgetDaily) {
            yield* post(
              place,
              `Daily budget reached (${spent.toFixed(2)} of ${settings.budgetDaily}). Raise it with /budget.`,
            );
            return;
          }
        }
        yield* holdChat(place);
        yield* keepTyping(place);
        const started = yield* agent.begin({
          chatId: place,
          threadId: place,
          text,
          where: yield* host.placeLabel(place),
          requestId: `${place}:${messageId}`,
        });
        if (started === "folded") return;
        yield* waitForAnswerAndPost(place, place, true);
      }, Effect.scoped);

      const resolvePlace = (place: string) =>
        Effect.gen(function* () {
          const target = place || (yield* state.meta(LAST_TALKED_PLACE_META_KEY));
          if (!target) {
            return yield* new TelegramError({
              operation: "place",
              cause: "nobody has talked to this agent yet",
            });
          }
          return target;
        });

      const startTurn = (
        text: string,
        requestId: string,
        source: "scheduled" | "approval" | "user",
        place: string,
      ) =>
        Effect.gen(function* () {
          const threadId = yield* resolvePlace(place);
          return yield* Effect.scoped(
            Effect.gen(function* () {
              yield* holdChat(threadId);
              const started = yield* agent.begin({
                chatId: threadId,
                threadId,
                text,
                requestId,
                source,
              });
              if (started === "folded") return "(folded into the turn already running there)";
              return yield* waitForAnswerAndPost(threadId, threadId);
            }),
          );
        });

      const beginWebTurn = (
        place: string,
        text: string,
        requestId: string,
        where: string,
        first: boolean,
      ): Effect.Effect<WebTurnResult, AgentError | StateError | TelegramError> =>
        Effect.gen(function* () {
          if (settings.budgetDaily > 0) {
            const spent = yield* usage.spentSince(Date.now() - DAY_MS);
            if (spent >= settings.budgetDaily)
              return {
                ok: false as const,
                reason: `Daily budget reached (${spent.toFixed(2)} of ${settings.budgetDaily}). Raise it with /budget.`,
              };
          }
          const started = yield* agent.begin({
            chatId: place,
            threadId: place,
            text,
            where,
            requestId: `${place}:${requestId}`,
            source: "user",
          });
          if (started === "folded") return { ok: true as const, folded: true };
          yield* Effect.forkDetach(
            Effect.scoped(
              Effect.andThen(
                holdChat(place),
                waitForAnswerAndPost(place, place, false, first ? where : undefined),
              ),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("web turn failed", cause).pipe(
                  Effect.andThen(
                    deliver(
                      place,
                      "Something went wrong on my side. I'll try to finish that.",
                    ).pipe(Effect.ignore),
                  ),
                  Effect.andThen(webChat.setStatus(place, false, []).pipe(Effect.ignore)),
                ),
              ),
            ),
          );
          return { ok: true as const, folded: false };
        });

      const nextWake = Effect.map(agent.pending, (pending) =>
        pending.length > 0 ? Date.now() + RECOVER_AFTER_MS : undefined,
      );

      const approve = (id: number, approved: boolean, always = false) =>
        Effect.gen(function* () {
          const taken = yield* approvals.take(id);
          if (!taken) return undefined;
          if (always && taken.match !== "") yield* policies.add(taken.match, "allow");
          const resume = Effect.gen(function* () {
            const isOurOwnAgentChange = taken.action !== "";
            if (isOurOwnAgentChange) {
              const result = approved
                ? yield* applyAgentAction(host, taken.action)
                : "Nothing was changed.";
              yield* startTurn(
                approved
                  ? `[approval] The user approved. ${result}`
                  : `[approval] The user denied it. Do not try again or work around it. ${result}`,
                `approval:${id}`,
                "approval",
                taken.place,
              );
              return;
            }
            const result = yield* executor
              .call("resume", {
                executionId: taken.executionId,
                action: approved ? "accept" : "decline",
              })
              .pipe(Effect.catch((error) => Effect.succeed(`Error: ${error.message}`)));
            yield* startTurn(
              approved
                ? `[approval] The user approved. Executor's result:\n${clipToolOutput(result)}`
                : `[approval] The user denied it. Do not try again or work around it. Executor said:\n${clipToolOutput(result, MAX_QUOTED_CHARS)}`,
              `approval:${id}`,
              "approval",
              taken.place,
            );
          }).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) => Effect.logError("approval failed", cause)),
          );
          return { resume };
        });

      const answer = (actionId: string, userId: string, threadId: string) =>
        Effect.gen(function* () {
          if (!settings.allowedUserIds.has(userId)) return;
          const [verb, agentId, rawId] = actionId.split(":");
          const approved = verb === "approve" || verb === "always";
          const always = verb === "always";
          if ((!approved && verb !== "deny") || rawId === undefined) return;
          const strayPressForAnotherAgent = agentId !== host.self.id;
          if (strayPressForAnotherAgent) return;
          const pending = yield* approve(Number(rawId), approved, always);
          if (!pending) {
            yield* post(threadId, "That question expired or was already answered.");
            return;
          }
          yield* pending.resume;
        });

      chat.onAction((event) =>
        run(
          answer(event.actionId, String(event.user.userId), event.threadId).pipe(
            Effect.catchCause((cause) => Effect.logError("approval failed", cause)),
          ),
        ),
      );

      const onSlashCommand = (event: SlashCommandEvent) =>
        run(
          Effect.gen(function* () {
            const threadId = event.channel.id;
            const userId = String(event.user.userId);
            if (!settings.allowedUserIds.has(userId)) {
              yield* tellStrangerTheirId(threadId, event.channel.isDM, userId);
              return;
            }
            const name = event.command.replace(/^\//, "").replace(/@.*$/, "").toLowerCase();
            const talksToThisAgentForOneMessage =
              name === host.self.slug && !COMMAND_NAMES.has(name);
            if (talksToThisAgentForOneMessage) {
              yield* invokeBySlug(threadId, event);
              return;
            }
            const reply =
              name === "start"
                ? GREETING(host.self.name)
                : yield* commands.run(threadId, `/${name} ${event.text}`.trim());
            yield* post(threadId, reply ?? "That is not a command. Try /help.");
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("command failed", cause).pipe(
                Effect.andThen(
                  post(event.channel.id, "That command failed on my side.").pipe(Effect.ignore),
                ),
              ),
            ),
          ),
        );
      chat.onSlashCommand(onSlashCommand);

      const invokeBySlug = (place: string, event: SlashCommandEvent) =>
        Effect.gen(function* () {
          const raw = event.raw as {
            message_id?: number;
            reply_to_message?: { text?: string; caption?: string; from?: { username?: string } };
          };
          const messageId = String(raw.message_id ?? Date.now());
          yield* reactWithReceipt(place, messageId);
          const replied = raw.reply_to_message;
          const repliedText = (replied?.text ?? replied?.caption ?? "").trim();
          const quoted =
            repliedText === ""
              ? ""
              : `[replying to ${replied?.from?.username ?? "an earlier message"}: ${clipToolOutput(repliedText, MAX_QUOTED_CHARS)}]`;
          const said = [quoted, event.text.trim()].filter((part) => part !== "").join("\n");
          if (said === "") {
            yield* post(place, `Say something after /${host.self.slug}, or use it as a reply.`);
            return;
          }
          yield* converse(place, said, messageId);
        });

      const onMessage = (thread: Thread, message: Message) =>
        run(
          handleMessage(thread, message).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("message handling failed", cause).pipe(
                Effect.andThen(
                  post(thread.id, "Something went wrong on my side. I'll try to finish that.").pipe(
                    Effect.ignore,
                  ),
                ),
              ),
            ),
          ),
        );

      chat.onDirectMessage(onMessage);
      chat.onNewMention(onMessage);
      const onPlainGroupTopicMessage = onMessage;
      chat.onNewMessage(onPlainGroupTopicMessage);

      return Bot.of({
        approve,
        nextWake,
        turn: (place, text, requestId) => startTurn(text, requestId, "scheduled", place),
        beginWebTurn,
        postTo: (place, text) =>
          Effect.flatMap(resolvePlace(place), (target) => deliver(target, text)),
        webhook: (request, waitUntil) =>
          Effect.tryPromise({
            try: () => chat.webhooks.telegram(request, { waitUntil }),
            catch: (cause) => new TelegramError({ operation: "webhook", cause }),
          }),

        recover: Effect.gen(function* () {
          const turns = yield* agent.pending;
          for (const turn of turns) {
            if (!isOrphanOfRestart(turn.chatId)) continue;
            yield* Effect.scoped(
              Effect.andThen(
                holdChat(turn.chatId),
                waitForAnswerAndPost(turn.chatId, turn.threadId),
              ),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(`recovering the turn of ${turn.chatId} failed`, cause),
              ),
            );
          }
          return (yield* agent.pending).length;
        }),
      });
    }),
  );
}
