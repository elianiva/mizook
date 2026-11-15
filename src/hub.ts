import { DurableObject } from "cloudflare:workers";
import type { ChannelInfo } from "./host.ts";
import type { Env } from "./env.ts";

/**
 * The registry of channels. Each channel is its own Durable Object and knows nothing of the
 * others; the Hub is how they find each other by name (`/channels`, `ask_channel`).
 */
export class Hub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS channels (
         do_name TEXT PRIMARY KEY, thread_id TEXT NOT NULL, name TEXT NOT NULL,
         last_active INTEGER NOT NULL)`,
    );
  }

  /** A channel was used. A name given here replaces the old one; none keeps it. */
  register(doName: string, threadId: string, name: string | undefined): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO channels (do_name, thread_id, name, last_active) VALUES (?, ?, ?, ?)
       ON CONFLICT (do_name) DO UPDATE SET last_active = excluded.last_active,
         name = CASE WHEN ? THEN excluded.name ELSE channels.name END`,
      doName,
      threadId,
      name ?? doName,
      Date.now(),
      name === undefined ? 0 : 1,
    );
  }

  list(): ChannelInfo[] {
    return this.ctx.storage.sql
      .exec<{ do_name: string; thread_id: string; name: string; last_active: number }>(
        `SELECT do_name, thread_id, name, last_active FROM channels ORDER BY last_active DESC`,
      )
      .toArray()
      .map((r) => ({
        doName: r.do_name,
        threadId: r.thread_id,
        name: r.name,
        lastActive: r.last_active,
      }));
  }
}
