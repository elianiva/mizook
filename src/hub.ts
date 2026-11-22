import { DurableObject } from "cloudflare:workers";
import { COMMANDS } from "./command-list.ts";
import type { AgentInfo, Profile } from "./host.ts";
import type { Env } from "./env.ts";

/** Commands an agent's slug may not take: they already mean something. */
const RESERVED = new Set<string>([...COMMANDS.map((c) => c.command), "start"]);

const DEFAULT_SLUG = "mizook";

const randomId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    "abcdefghijklmnopqrstuvwxyz0123456789".charAt(b % 36),
  ).join("");

type AgentRow = {
  id: string;
  slug: string;
  name: string;
  created: number;
  last_active: number;
};

/**
 * The registry: the agents, which Telegram place uses which agent, the names of places, and the
 * profile every agent shares. Each agent is its own Durable Object and knows nothing of the
 * others; the Hub is how they and the Worker find each other.
 */
export class Hub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    // Channels were per topic before agents; their objects are gone with the old class.
    sql.exec(`DROP TABLE IF EXISTS channels`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS agents (
         id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
         created INTEGER NOT NULL, last_active INTEGER NOT NULL DEFAULT 0)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS bindings (place TEXT PRIMARY KEY, agent_id TEXT NOT NULL)`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS places (place TEXT PRIMARY KEY, name TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS hub_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS profile (
         id INTEGER PRIMARY KEY CHECK (id = 1), about TEXT NOT NULL,
         rules TEXT NOT NULL, updated INTEGER NOT NULL)`,
    );
    // A fresh install has one agent, and it answers everywhere.
    if (sql.exec(`SELECT 1 FROM agents LIMIT 1`).toArray().length === 0) {
      const id = randomId();
      sql.exec(
        `INSERT INTO agents (id, slug, name, created) VALUES (?, ?, ?, ?)`,
        id,
        DEFAULT_SLUG,
        env.AGENT_NAME || "Mizook",
        Date.now(),
      );
      sql.exec(`INSERT INTO hub_meta (key, value) VALUES ('default', ?)`, id);
    }
  }

  private get defaultId(): string {
    return this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM hub_meta WHERE key = 'default'`)
      .one().value;
  }

  private info(row: AgentRow): AgentInfo {
    const bound = this.ctx.storage.sql
      .exec<{ place: string }>(`SELECT place FROM bindings WHERE agent_id = ?`, row.id)
      .toArray()
      .map((b) => b.place);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      doName: `agent:${row.id}`,
      isDefault: row.id === this.defaultId,
      bound,
      created: row.created,
      lastActive: row.last_active,
    };
  }

  private row(key: string): AgentRow | undefined {
    return this.ctx.storage.sql
      .exec<AgentRow>(
        `SELECT id, slug, name, created, last_active FROM agents WHERE id = ? OR slug = ?`,
        key,
        key.toLowerCase(),
      )
      .toArray()[0];
  }

  agents(): AgentInfo[] {
    return this.ctx.storage.sql
      .exec<AgentRow>(`SELECT id, slug, name, created, last_active FROM agents ORDER BY created`)
      .toArray()
      .map((row) => this.info(row));
  }

  /** One agent, by id or slug. */
  agent(key: string): AgentInfo | undefined {
    const row = this.row(key);
    return row && this.info(row);
  }

  /**
   * Which agent an update goes to: the agent a callback belongs to, the agent a command names
   * (`/grok …`), the agent bound to the place, or the default.
   */
  route(place: string, command: string | undefined, agentId: string | undefined): AgentInfo {
    const bound = this.ctx.storage.sql
      .exec<{ agent_id: string }>(`SELECT agent_id FROM bindings WHERE place = ?`, place)
      .toArray()[0];
    const row =
      (agentId !== undefined ? this.row(agentId) : undefined) ??
      (command !== undefined && !RESERVED.has(command) ? this.row(command) : undefined) ??
      (bound && this.row(bound.agent_id)) ??
      this.row(this.defaultId)!;
    this.ctx.storage.sql.exec(`UPDATE agents SET last_active = ? WHERE id = ?`, Date.now(), row.id);
    return this.info(row);
  }

  /** Make `place` use the agent `key`, or the default when `key` is undefined. */
  bind(place: string, key: string | undefined): AgentInfo | undefined {
    if (key === undefined) {
      this.ctx.storage.sql.exec(`DELETE FROM bindings WHERE place = ?`, place);
      return this.agent(this.defaultId);
    }
    const row = this.row(key);
    if (!row) return undefined;
    this.ctx.storage.sql.exec(
      `INSERT INTO bindings (place, agent_id) VALUES (?, ?)
       ON CONFLICT (place) DO UPDATE SET agent_id = excluded.agent_id`,
      place,
      row.id,
    );
    return this.info(row);
  }

  /** What a place is called: the name the user gave it, or undefined. */
  placeName(place: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ name: string }>(`SELECT name FROM places WHERE place = ?`, place)
      .toArray()[0]?.name;
  }

  setPlaceName(place: string, name: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO places (place, name) VALUES (?, ?)
       ON CONFLICT (place) DO UPDATE SET name = excluded.name`,
      place,
      name,
    );
  }

  places(): Array<{ place: string; name: string }> {
    return this.ctx.storage.sql
      .exec<{ place: string; name: string }>(`SELECT place, name FROM places ORDER BY name`)
      .toArray();
  }

  /** The one profile every agent shares. A missing row is an empty profile. */
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
}
