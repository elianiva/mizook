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
import { Usage, type Spend } from "./usage.ts";

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

  /** What this channel has spent, for `/cost`. */
  async spend(): Promise<Spend> {
    return this.runtime.runPromise(Usage.use((usage) => usage.spend));
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
