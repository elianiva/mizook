import { DurableObject } from "cloudflare:workers";
import { type Context, Effect } from "effect";
import { Agent } from "./agent.ts";
import { Backup } from "./backup.ts";
import { Bot, RECOVER_AFTER_MS } from "./bot.ts";
import type { Env } from "./env.ts";
import { ToolError } from "./errors.ts";
import type { ChannelInfo } from "./host.ts";
import { Host } from "./host.ts";
import { makeRuntime, type AppRuntime } from "./runtime.ts";
import { hookToken } from "./hooks.ts";
import { Usage, type Spend } from "./usage.ts";
import { Schedules } from "./schedules.ts";
import { Commands } from "./commands.ts";
import { State } from "./state.ts";
import * as read from "./admin/read.ts";

type Hosted = Context.Service.Shape<typeof Host>;

/** The Hub's methods, spelled out: its stub type loops back through `Env`. */
interface HubApi {
  register(doName: string, threadId: string, name: string | undefined): Promise<void>;
  list(): Promise<ChannelInfo[]>;
}

interface ChannelApi {
  ask(question: string): Promise<string>;
  spend(): Promise<Spend>;
}

/**
 * One channel: a Telegram forum topic, a group's General topic or a DM. It owns the memory,
 * pi-durable, the schedules and the bot for that channel, in one Durable Object with one SQLite.
 */
export class ChatAgent extends DurableObject<Env> {
  private runtime: AppRuntime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = makeRuntime(ctx.storage, env, this.host());
    // Build the layers (open the storage, resume what a restart interrupted) before any request.
    // Delivering a turn can take minutes, so work starts after this, not inside it: the gate has 30 seconds.
    void ctx
      .blockConcurrencyWhile(() => this.runtime.runPromise(Effect.void))
      .then(() => this.alarm());
  }

  private get doName(): string {
    return this.ctx.id.name ?? "main";
  }

  private hub(): HubApi {
    return this.env.Hub.getByName("hub") as unknown as HubApi;
  }

  /** Swap in a fresh runtime so new settings take effect, once the reply that asked for it is out. */
  private reloadRuntime(): void {
    const old = this.runtime;
    this.ctx.waitUntil(
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await old.dispose();
        this.runtime = makeRuntime(this.ctx.storage, this.env, this.host());
        await this.runtime.runPromise(Effect.void);
      })(),
    );
  }

  /** What this channel can ask of the world outside it. */
  private host(): Hosted {
    const hub = () => this.hub();
    const doName = this.doName;
    const reload = () => this.reloadRuntime();
    const exportLink = this.runtimeEffect(Backup.use((backup) => backup.exportLink));
    const peer = (name: string) => this.env.ChatAgent.getByName(name) as unknown as ChannelApi;
    return {
      reload: Effect.sync(reload),
      hookUrl: Effect.promise(async () => {
        const token = await hookToken(this.env.MIZOOK_WEBHOOK_SECRET, doName);
        return `${this.env.PUBLIC_URL ?? ""}/hook/${encodeURIComponent(doName)}/${token}`;
      }),
      register: (threadId, name) => Effect.promise(() => hub().register(doName, threadId, name)),
      channels: Effect.promise(() => hub().list()),
      ask: (channel, question) =>
        Effect.gen(function* () {
          const all = yield* Effect.promise(() => hub().list());
          const wanted = channel.trim().toLowerCase();
          const found = all.find((c) => c.name.toLowerCase() === wanted || c.doName === channel);
          if (!found) {
            return yield* new ToolError({
              reason: `no channel "${channel}". Channels: ${all.map((c) => c.name).join(", ") || "none yet"}`,
            });
          }
          if (found.doName === doName) {
            return yield* new ToolError({ reason: "that is this channel: use your own memory" });
          }
          return yield* Effect.tryPromise({
            try: () => peer(found.doName).ask(question),
            catch: (cause) =>
              new ToolError({ reason: `asking ${found.name} failed: ${String(cause)}` }),
          });
        }),
      spendAll: Effect.gen(function* () {
        const all: ChannelInfo[] = yield* Effect.promise(() => hub().list());
        return yield* Effect.forEach(all, (c) =>
          Effect.promise(() => peer(c.doName).spend()).pipe(
            Effect.map((spend) => ({ name: c.name, spend })),
          ),
        );
      }),
      exportNow: exportLink,
    };
  }

  private runtimeEffect<A, E>(effect: Effect.Effect<A, E, Backup>): Effect.Effect<A> {
    return Effect.promise(() => this.runtime.runPromise(effect as never) as Promise<A>);
  }

  /** Called by another channel through `ask_channel`: read-only, nothing is logged here. */
  async ask(question: string): Promise<string> {
    return this.runtime.runPromise(Agent.use((agent) => agent.ask(question)));
  }

  /** A webhook call, already checked by the Worker. */
  async hook(body: string): Promise<boolean> {
    return this.runtime.runPromise(Bot.use((bot) => bot.hook(body)));
  }

  /** What this channel has spent, for `/cost`. */
  async spend(): Promise<Spend> {
    return this.runtime.runPromise(Usage.use((usage) => usage.spend));
  }

  /** Read-only data for the dashboard, already authorised by the Worker. */
  async dashboard(page: string, params: Record<string, string>): Promise<unknown> {
    const sql = {
      all: <T>(query: string, ...args: unknown[]) =>
        this.ctx.storage.sql.exec(query, ...(args as never[])).toArray() as T[],
    };
    const now = Date.now();
    const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
    switch (page) {
      case "overview":
        return read.overview(sql, now);
      case "messages":
        return read.messages(sql, {
          ...(params.kind && { kind: params.kind }),
          ...(params.q && { q: params.q }),
          ...(num(params.before) !== undefined && { before: num(params.before)! }),
          limit: Math.min(Math.max(num(params.limit) ?? 50, 1), 50),
        });
      case "message":
        return read.message(sql, Number(params.i));
      case "memory":
        return read.memoryView(sql);
      case "usage":
        return read.usage(sql, Math.min(Math.max(Number(params.days) || 30, 1), 365), now);
      case "schedules":
        return read.schedules(sql);
      case "audit":
        return read.audit(sql);
      default:
        return undefined;
    }
  }

  /**
   * A write from the dashboard, already authorised by the Worker. It goes through the runtime, so
   * it shares the one SQLite writer with the bot. Every call is audited. False when the item was
   * already gone.
   */
  async act(who: string, action: string, id: number): Promise<boolean> {
    const done = await this.runtime.runPromise(
      Effect.gen(function* () {
        const bot = yield* Bot;
        if (action === "approve" || action === "deny") {
          const pending = yield* bot.approve(id, action === "approve");
          if (!pending) return { ok: false, after: undefined };
          return { ok: true, after: pending.resume };
        }
        if (action === "cancel_schedule") {
          const schedules = yield* Schedules;
          return { ok: yield* schedules.cancel(id), after: undefined };
        }
        return { ok: false, after: undefined };
      }),
    );
    await this.runtime.runPromise(State.use((state) => state.audit(who, action, id, done.ok)));
    // Answering an approval resumes Executor and starts a turn: that takes a while, so it goes on after the reply.
    if (done.after) {
      const after = done.after;
      this.ctx.waitUntil(this.runtime.runPromise(after).then(() => this.rearm()));
    }
    return done.ok;
  }

  /** Stop the turn that is running, as `/stop` does. */
  async stop(who: string): Promise<boolean> {
    const stopped = await this.runtime.runPromise(
      Effect.gen(function* () {
        const thread = yield* (yield* State).meta("thread");
        return thread === undefined ? false : yield* (yield* Agent).stop(thread);
      }),
    );
    await this.runtime.runPromise(State.use((state) => state.audit(who, "stop", 0, stopped)));
    return stopped;
  }

  /**
   * Change one of this channel's settings the way its slash command does, so the checks and the
   * reload are the command's own. `undefined` resets it. Returns the command's reply.
   */
  async setting(who: string, key: string, value: string | undefined): Promise<string> {
    const reply = await this.runtime.runPromise(
      Effect.gen(function* () {
        const thread = yield* (yield* State).meta("thread");
        if (thread === undefined) return "Nothing has been said in this channel yet.";
        const text = `/${key} ${value === undefined ? "reset" : value}`;
        return (yield* (yield* Commands).run(thread, thread, text)) ?? "Unknown setting.";
      }),
    );
    await this.runtime.runPromise(State.use((state) => state.audit(who, `set:${key}`, 0, true)));
    return reply;
  }

  override async fetch(request: Request): Promise<Response> {
    const response = await this.runtime.runPromise(
      Bot.use((bot) => bot.webhook(request, (task) => this.ctx.waitUntil(task))),
    );
    // While a turn runs this process may be evicted: the alarm brings it back to finish the turn.
    await this.rearm();
    return response;
  }

  /** The one alarm serves recovery of interrupted turns, schedules and the nightly backup. */
  override async alarm(): Promise<void> {
    const attempt = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
      this.runtime.runPromise(effect as never).catch((error) => {
        console.error(`${label} failed`, error);
      });
    await attempt(
      "recovery",
      Bot.use((bot) => bot.recover),
    );
    await attempt(
      "schedules",
      Bot.use((bot) => bot.wake),
    );
    await attempt(
      "backup",
      Backup.use((backup) => backup.backupIfDue(Date.now())),
    );
    await this.rearm();
  }

  private async rearm(): Promise<void> {
    const times = await Promise.all([
      this.runtime
        .runPromise(Bot.use((bot) => bot.nextWake))
        .catch(() => Date.now() + RECOVER_AFTER_MS),
      this.runtime.runPromise(Backup.use((backup) => backup.nextBackupAt)).catch(() => undefined),
    ]);
    const at = times.filter((t): t is number => t !== undefined);
    if (at.length > 0) await this.ctx.storage.setAlarm(Math.min(...at));
  }
}
