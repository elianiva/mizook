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
import { Context, DateTime, Duration, Effect, Layer, Redacted, Schedule } from "effect";
import { Agent, type AgentError } from "./agent.ts";
import { chunk } from "./chunk.ts";
import { Settings } from "./config.ts";
import { TelegramError, type StateError } from "./errors.ts";
import { Outbox } from "./outbox.ts";
import { Approvals } from "./approvals.ts";
import { Policies } from "./policies.ts";
import { Executor } from "./executor.ts";
import { Blobs } from "./blobs.ts";
import { Commands } from "./commands.ts";
import { Host } from "./host.ts";
import { Usage } from "./usage.ts";
import { Schedules, type Schedule as Scheduled } from "./schedules.ts";
import { State } from "./state.ts";
import { Web } from "./search.ts";
import { sha256 } from "./web.ts";

/** How long an interrupted turn waits for the next alarm before something picks it up. */
export const RECOVER_AFTER_MS = 30_000;
/** Most turns schedules may start in an hour: a bad watch must not flood the chat or the budget. */
const FIRES_PER_HOUR = 20;
/** How long the user must stop typing before a run of messages is answered, and the longest a run may wait. */
const BURST_QUIET_MS = 1_500;
const BURST_MAX_MS = 8_000;

const GREETING = (name: string) =>
  `hey, ${name} here. I remember everything said in this chat, so no resets. what are we doing?`;

export class Bot extends Context.Service<
  Bot,
  {
    /** Answer a Telegram webhook. Work the update starts goes on in the background through `waitUntil`. */
    webhook(
      request: Request,
      waitUntil: (task: Promise<unknown>) => void,
    ): Effect.Effect<Response, TelegramError>;
    /** Deliver the replies of turns a restart interrupted. Returns how many turns are still pending. */
    readonly recover: Effect.Effect<number, AgentError | TelegramError>;
    /** A webhook call: start a turn with its body. False when the channel is silent or over its hourly limit. */
    hook(body: string): Effect.Effect<boolean, AgentError | StateError | TelegramError>;
    /**
     * Take an approval off the list. Undefined when it was already answered; otherwise the work of
     * answering it (resume Executor, tell the chat), for the caller to run when it chooses.
     */
    approve(
      id: number,
      approved: boolean,
      always?: boolean,
    ): Effect.Effect<{ readonly resume: Effect.Effect<void> } | undefined, StateError>;
    /** Start a turn for each schedule that is due. */
    readonly wake: Effect.Effect<void, AgentError | StateError>;
    /** When the Durable Object's alarm should ring next: a pending turn's recovery or the next schedule. */
    readonly nextWake: Effect.Effect<number | undefined, AgentError | StateError>;
  }
>()("mizook/Bot") {
  static readonly layer = Layer.effect(
    Bot,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const agent = yield* Agent;
      const state = yield* State;
      const schedules = yield* Schedules;
      const commands = yield* Commands;
      const outbox = yield* Outbox;
      const approvals = yield* Approvals;
      const policies = yield* Policies;
      const executor = yield* Executor;
      const blobs = yield* Blobs;
      const usage = yield* Usage;
      const host = yield* Host;
      const web = yield* Web;
      const services = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(services);

      /**
       * Chats this process is handling a message or delivering a turn for. A pending turn of a chat
       * not in here is an orphan of a restart.
       */
      const active = new Map<string, number>();
      const hold = (chatId: string) =>
        Effect.acquireRelease(
          Effect.sync(() => void active.set(chatId, (active.get(chatId) ?? 0) + 1)),
          () =>
            Effect.sync(() => {
              const left = (active.get(chatId) ?? 1) - 1;
              if (left > 0) active.set(chatId, left);
              else active.delete(chatId);
            }),
        );

      /** Messages typed in a quick run, by chat, while the first of them waits for the run to end. */
      const bursts = new Map<string, string[]>();

      const telegram = createTelegramAdapter({
        botToken: Redacted.value(settings.botToken),
        secretToken: Redacted.value(settings.webhookSecret),
        userName: settings.botUsername,
        mode: "webhook",
        // Who may talk to the bot is decided in the handler, which tells a stranger their id. The adapter would otherwise
        // read TELEGRAM_ALLOWED_USER_IDS from the environment and drop them without a word.
        allowedUserIds: [],
      });
      const chat = new Chat({
        userName: settings.botUsername,
        adapters: { telegram },
        // One Durable Object owns the bot, so the state is in its memory. Duplicates are caught by our own `app_seen`.
        state: createMemoryState(),
        // A message sent while the agent works must reach it: the agent folds it into the running turn.
        concurrency: "concurrent",
        logger: "warn",
      });

      const post = (threadId: string, text: string) =>
        Effect.tryPromise({
          try: async () => {
            // The Chat SDK connects its adapters on the first webhook; a recovery after a restart posts before one comes.
            await chat.initialize();
            const thread = chat.thread(threadId);
            for (const part of chunk(text)) await thread.post({ markdown: part });
          },
          catch: (cause) => new TelegramError({ operation: "post", cause }),
        });

      // Bubbles the agent sends mid-turn go straight to the chat.
      yield* outbox.attach((threadId, text) => post(threadId, text).pipe(Effect.ignore));

      /** Keep the "typing…" indicator up while the agent works: Telegram drops it after five seconds. */
      const typing = (threadId: string) =>
        Effect.tryPromise({
          try: async () => {
            await chat.initialize();
            await chat.thread(threadId).startTyping();
          },
          catch: (cause) => new TelegramError({ operation: "typing", cause }),
        }).pipe(
          Effect.ignore,
          Effect.repeat(Schedule.spaced(Duration.seconds(4))),
          Effect.forkScoped,
        );

      /** Show each question Executor paused on as a card with Approve and Deny. */
      const postApprovals = (threadId: string) =>
        Effect.gen(function* () {
          for (const a of yield* approvals.unposted) {
            yield* Effect.tryPromise({
              try: async () => {
                await chat.initialize();
                await chat.thread(threadId).post({
                  card: Card({
                    title: "Approval needed",
                    children: [
                      CardText(a.summary),
                      Actions([
                        Button({ id: `approve:${a.id}`, label: "Approve", style: "primary" }),
                        ...(a.match === ""
                          ? []
                          : [
                              Button({
                                id: `always:${a.id}`,
                                label: "Always allow",
                                style: "primary",
                              }),
                            ]),
                        Button({ id: `deny:${a.id}`, label: "Deny", style: "danger" }),
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

      /** Wait for a started turn's answer and post it. */
      const deliver = (chatId: string, threadId: string, typingStarted = false) =>
        Effect.gen(function* () {
          if (!typingStarted) yield* typing(threadId);
          const reply = yield* agent.finish(chatId);
          if (reply.trim() !== "") yield* post(threadId, reply);
          yield* postApprovals(threadId);
        }).pipe(Effect.scoped);

      const handleMessage = Effect.fn("Bot.message")(function* (thread: Thread, message: Message) {
        const userId = String(message.author.userId);
        if (message.author.isMe) return;
        if (!settings.allowedUserIds.has(userId)) {
          // In a group other members talk too: only a DM gets told its id.
          if (!thread.isDM) return;
          yield* post(
            thread.id,
            `You're not allowed to use this bot. Your Telegram id is ${userId}.`,
          );
          return;
        }
        // A receipt before any model work: the eye means the message reached the chat's Durable
        // Object. If it arrives but typing does not, the wait is inference, not delivery.
        yield* Effect.tryPromise({
          try: () => telegram.addReaction(thread.id, message.id, "👀"),
          catch: (cause) => new TelegramError({ operation: "reaction", cause }),
        }).pipe(Effect.ignore);
        const typed = message.text.trim();
        // Files the user sends are kept in the blob store; the agent is told their names and keys.
        const saved: string[] = [];
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
            saved.push(
              `[attached ${file.type}: ${name}, ${file.mimeType ?? "unknown type"}, ${bytes.length} bytes, key ${key}]`,
            );
          }
        }
        // A reply is part of what the user said: the agent sees what it answers, not just its own text.
        const replied = message.replyTo;
        const quoted = replied
          ? `[replying to ${replied.author.userName || "an earlier message"}: ${
              replied.text.trim() === ""
                ? `${replied.attachments.length} attachment(s)`
                : clipToolOutput(replied.text.trim(), 2_000)
            }]`
          : "";
        const joined = [quoted, typed, ...saved].filter((part) => part !== "").join("\n");
        if (joined === "") return;
        if (joined === "/start") {
          yield* post(thread.id, GREETING(settings.agentName));
          return;
        }
        // Slash commands are the user's controls: they never reach the model.
        const reply = yield* commands.run(thread.id, thread.id, joined);
        if (reply !== undefined) {
          yield* post(thread.id, reply);
          return;
        }
        // Telegram redelivers an update it did not get an answer to in time.
        if (!(yield* state.firstSeen(`${thread.id}:${message.id}`))) return;

        // The thread id names the forum topic too; `channelId` is only the group.
        const chatId = thread.id;
        // Schedules of this channel post here.
        yield* state.setMeta("thread", thread.id);
        yield* host.register(thread.id, undefined);
        // Several short messages in a row are one thought: wait until the typing stops, then answer once.
        // While a turn runs this is skipped, and the message is folded into it below.
        let text = joined;
        const burst = bursts.get(chatId);
        if (burst) {
          burst.push(text);
          return;
        }
        if (!(yield* state.turn(chatId))) {
          const mine = [text];
          bursts.set(chatId, mine);
          const began = Date.now();
          let seen = 0;
          yield* Effect.whileLoop({
            while: () => mine.length !== seen && Date.now() - began < BURST_MAX_MS,
            body: () => {
              seen = mine.length;
              return Effect.sleep(Duration.millis(BURST_QUIET_MS));
            },
            step: () => {},
          }).pipe(Effect.ensuring(Effect.sync(() => void bursts.delete(chatId))));
          text = mine.join("\n");
        }
        if (settings.budgetDaily > 0) {
          const spent = yield* usage.spentSince(Date.now() - 24 * 3_600_000);
          if (spent >= settings.budgetDaily) {
            yield* post(
              thread.id,
              `Daily budget reached (${spent.toFixed(2)} of ${settings.budgetDaily}). Raise it with /budget.`,
            );
            return;
          }
        }
        yield* hold(chatId);
        // Beginning a turn can wait seconds for the last messages to be summarized: show typing first.
        yield* typing(thread.id);
        const started = yield* agent.begin({
          chatId,
          threadId: thread.id,
          text,
          requestId: `${thread.id}:${message.id}`,
        });
        if (started === "folded") return;
        yield* deliver(chatId, thread.id, true);
      }, Effect.scoped);

      const nowDate = Effect.map(DateTime.now, (n) => new Date(DateTime.toEpochMillis(n)));

      /** The message a due schedule starts a turn with, or nothing when it stays silent. */
      const textOf = (s: Scheduled) =>
        Effect.gen(function* () {
          const skill = s.skill === undefined ? "" : `Read skill "${s.skill}" first.\n\n`;
          if (s.spec.kind !== "watch") return `[scheduled #${s.id}] ${skill}${s.prompt}`;
          const page = yield* web.fetch(s.spec.url).pipe(
            Effect.map((p) => p.text),
            Effect.catch((error) =>
              Effect.logWarning(`watch #${s.id} failed: ${error.message}`).pipe(
                Effect.as(undefined),
              ),
            ),
          );
          if (page === undefined) return undefined;
          const changed = yield* schedules.watchChanged(
            s.id,
            yield* Effect.promise(() => sha256(page)),
          );
          return changed
            ? `[watch #${s.id} changed] ${skill}${s.prompt}\n\n${s.spec.url} now reads:\n${clipToolOutput(page)}`
            : undefined;
        });

      const wake = Effect.gen(function* () {
        const now = yield* nowDate;
        const due = yield* schedules.claim(now);
        const threadId = yield* state.meta("thread");
        // Nothing has been said in this channel yet, so there is nowhere to post.
        if (due.length === 0 || !threadId) return;
        for (const s of due) {
          const text = yield* textOf(s);
          if (text === undefined) continue;
          if (!(yield* schedules.allow(now, FIRES_PER_HOUR))) {
            yield* Effect.logWarning(
              `schedule #${s.id} skipped: over ${FIRES_PER_HOUR} fires an hour`,
            );
            continue;
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* hold(threadId);
              const started = yield* agent.begin({
                chatId: threadId,
                threadId,
                text,
                requestId: `sched:${s.id}:${s.nextAt}`,
                source: "scheduled",
              });
              if (started === "started") yield* deliver(threadId, threadId);
            }),
          ).pipe(Effect.catchCause((cause) => Effect.logError(`schedule #${s.id} failed`, cause)));
        }
      });

      /** Start a turn from something that is not a Telegram message. Silent when nothing was said here yet. */
      const fire = (text: string, requestId: string, source: "webhook" | "approval") =>
        Effect.gen(function* () {
          const threadId = yield* state.meta("thread");
          if (!threadId) return false;
          if (!(yield* schedules.allow(yield* nowDate, FIRES_PER_HOUR))) return false;
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* hold(threadId);
              const started = yield* agent.begin({
                chatId: threadId,
                threadId,
                text,
                requestId,
                source,
              });
              if (started === "started") yield* deliver(threadId, threadId);
            }),
          );
          return true;
        });

      const hook = (body: string) =>
        fire(`[webhook] ${clipToolOutput(body, 8_000)}`, `hook:${crypto.randomUUID()}`, "webhook");

      const nextWake = Effect.gen(function* () {
        const pending =
          (yield* agent.pending).length > 0 ? Date.now() + RECOVER_AFTER_MS : undefined;
        const scheduled = yield* schedules.nextAt;
        const times = [pending, scheduled].filter((t): t is number => t !== undefined);
        return times.length === 0 ? undefined : Math.min(...times);
      });

      const approve = (id: number, approved: boolean, always = false) =>
        Effect.gen(function* () {
          const taken = yield* approvals.take(id);
          if (!taken) return undefined;
          if (always && taken.match !== "") yield* policies.add(taken.match, "allow");
          const resume = Effect.gen(function* () {
            const result = yield* executor
              .call("resume", {
                executionId: taken.executionId,
                action: approved ? "accept" : "decline",
              })
              .pipe(Effect.catch((error) => Effect.succeed(`Error: ${error.message}`)));
            yield* fire(
              approved
                ? `[approval] The user approved. Executor's result:\n${clipToolOutput(result)}`
                : `[approval] The user denied it. Do not try again or work around it. Executor said:\n${clipToolOutput(result, 2_000)}`,
              `approval:${id}`,
              "approval",
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
          const [verb, rawId] = actionId.split(":");
          const approved = verb === "approve" || verb === "always";
          const always = verb === "always";
          if ((!approved && verb !== "deny") || rawId === undefined) return;
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

      /** A `/command`: the adapter delivers these as slash-command events, not as messages. */
      const onSlashCommand = (event: SlashCommandEvent) =>
        run(
          Effect.gen(function* () {
            const threadId = event.channel.id;
            const userId = String(event.user.userId);
            if (!settings.allowedUserIds.has(userId)) {
              if (!event.channel.isDM) return;
              yield* post(
                threadId,
                `You're not allowed to use this bot. Your Telegram id is ${userId}.`,
              );
              return;
            }
            yield* state.setMeta("thread", threadId);
            yield* host.register(threadId, undefined);
            const name = event.command.replace(/^\//, "").replace(/@.*$/, "");
            const reply =
              name === "start"
                ? GREETING(settings.agentName)
                : yield* commands.run(threadId, threadId, `/${name} ${event.text}`.trim());
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

      const onMessage = (thread: Thread, message: Message) =>
        run(
          handleMessage(thread, message).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("message handling failed", cause).pipe(
                // The turn, if it started, stays recorded: a restart or the next alarm delivers it.
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
      // Plain messages in a group topic: not a DM, not a mention, and the thread is not subscribed.
      chat.onNewMessage(onMessage);

      return Bot.of({
        approve,
        wake,
        hook,
        nextWake,
        webhook: (request, waitUntil) =>
          Effect.tryPromise({
            try: () => chat.webhooks.telegram(request, { waitUntil }),
            catch: (cause) => new TelegramError({ operation: "webhook", cause }),
          }),

        recover: Effect.gen(function* () {
          const turns = yield* agent.pending;
          for (const turn of turns) {
            if (active.has(turn.chatId)) continue;
            yield* Effect.scoped(
              Effect.andThen(hold(turn.chatId), deliver(turn.chatId, turn.threadId)),
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
