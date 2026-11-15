import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { Bot, RECOVER_AFTER_MS } from "./bot.ts";
import type { Env } from "./env.ts";
import { makeRuntime, type AppRuntime } from "./runtime.ts";

/**
 * The one Durable Object that is the chat: it owns the memory, pi-durable, and the Telegram bot.
 * A Durable Object is a single process with transactional storage, which is what "one process
 * owns a chat" asks for.
 */
export class ChatAgent extends DurableObject<Env> {
  private readonly runtime: AppRuntime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = makeRuntime(ctx.storage, env);
    // Build the layers (open the storage, resume what a restart interrupted) before any request.
    // Delivering a turn can take minutes, so work starts after this, not inside it: the gate has 30 seconds.
    void ctx
      .blockConcurrencyWhile(() => this.runtime.runPromise(Effect.void))
      .then(() => this.alarm());
  }

  override async fetch(request: Request): Promise<Response> {
    const response = await this.runtime.runPromise(
      Bot.use((bot) => bot.webhook(request, (task) => this.ctx.waitUntil(task))),
    );
    // While a turn runs this process may be evicted: the alarm brings it back to finish the turn.
    await this.rearm();
    return response;
  }

  /** The one alarm serves recovery of interrupted turns and the schedules; each wake sets it again. */
  override async alarm(): Promise<void> {
    await this.runtime.runPromise(Bot.use((bot) => bot.recover)).catch((error) => {
      console.error("recovery failed", error);
    });
    await this.runtime.runPromise(Bot.use((bot) => bot.wake)).catch((error) => {
      console.error("schedules failed", error);
    });
    await this.rearm();
  }

  private async rearm(): Promise<void> {
    const at = await this.runtime
      .runPromise(Bot.use((bot) => bot.nextWake))
      .catch(() => Date.now() + RECOVER_AFTER_MS);
    if (at !== undefined) await this.ctx.storage.setAlarm(at);
  }
}
