import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { Bot } from "./bot.ts";
import type { Env } from "./env.ts";
import { makeRuntime, type AppRuntime } from "./runtime.ts";

/** How long an interrupted turn waits for the next alarm before something picks it up. */
const RECOVER_AFTER_MS = 30_000;

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
    // Delivering a turn can take minutes, so recovery starts after this, not inside it: the gate has 30 seconds.
    void ctx
      .blockConcurrencyWhile(() => this.runtime.runPromise(Effect.void))
      .then(() => this.recover());
  }

  override async fetch(request: Request): Promise<Response> {
    const response = await this.runtime.runPromise(
      Bot.use((bot) => bot.webhook(request, (task) => this.ctx.waitUntil(task))),
    );
    // While a turn runs this process may be evicted: the alarm brings it back to finish the turn.
    await this.scheduleRecovery();
    return response;
  }

  override async alarm(): Promise<void> {
    await this.recover();
  }

  /** Finish the turns a restart interrupted, and keep the alarm while any is pending. */
  private async recover(): Promise<void> {
    const pending = await this.runtime.runPromise(Bot.use((bot) => bot.recover)).catch((error) => {
      console.error("recovery failed", error);
      return 1;
    });
    if (pending > 0) await this.scheduleRecovery();
  }

  private async scheduleRecovery(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + RECOVER_AFTER_MS);
    }
  }
}
