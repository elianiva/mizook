import { DurableObject } from "cloudflare:workers";
import type { ChannelInfo, Profile } from "./host.ts";
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
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS profile (
         id INTEGER PRIMARY KEY CHECK (id = 1), about TEXT NOT NULL,
         rules TEXT NOT NULL, updated INTEGER NOT NULL)`,
    );
  }

  /** The one profile every channel shares. A missing row is an empty profile. */
  profile(): Profile {
    const row = this.ctx.storage.sql
      .exec<{ about: string; rules: string }>(`SELECT about, rules FROM profile WHERE id = 1`)
      .toArray()[0];
    if (!row) return { about: "", rules: [] };
    let rules: string[] = [];
    try {
      const parsed = JSON.parse(row.rules) as unknown;
      if (Array.isArray(parsed)) rules = parsed.filter((r): r is string => typeof r === "string");
    } catch {
      // A broken row reads as no rules; the next update replaces it.
    }
    return { about: row.about, rules };
  }

  /** Change the fields given and keep the rest. */
  setProfile(about: string | undefined, rules: string[] | undefined): Profile {
    const current = this.profile();
    const next = {
      about: about ?? current.about,
      rules: rules ?? current.rules,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO profile (id, about, rules, updated) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET about = excluded.about,
         rules = excluded.rules, updated = excluded.updated`,
      next.about,
      JSON.stringify(next.rules),
      Date.now(),
    );
    return next;
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
