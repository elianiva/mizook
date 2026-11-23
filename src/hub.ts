import { DurableObject } from "cloudflare:workers";
import type { SqlDriver } from "@mizook/memory/sqlite";
import { Effect, Option, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { AGENT_SLUG, menuWith, RESERVED_COMMANDS } from "./command-list.ts";
import type { AgentChange, AgentInfo, AgentSpec, Profile, WebThreadInfo } from "./host.ts";
import type { Env } from "./env.ts";
import { WEB_PERSONA, WEB_ROLE } from "./persona.ts";
import { Skills, type Skill } from "./skills.ts";

const DEFAULT_SLUG = "mizook";

const randomId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    "abcdefghijklmnopqrstuvwxyz0123456789".charAt(b % 36),
  ).join("");

type AgentRow = {
  id: string;
  slug: string;
  name: string;
  role: string;
  persona: string;
  tools: string;
  created: number;
  last_active: number;
};

type WebThreadRow = {
  id: string;
  agent_id: string;
  title: string;
  preview: string;
  created: number;
  updated: number;
  archived: number;
};

const COLUMNS = "id, slug, name, role, persona, tools, created, last_active";

const decodeJsonArray = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);

const parseStringList = (json: string): string[] | undefined =>
  Option.getOrUndefined(
    Option.map(decodeJsonArray(json), (parsed) =>
      parsed.filter((item): item is string => typeof item === "string"),
    ),
  );

const EVERY_TOOL = undefined;

export class Hub extends DurableObject<Env> {
  private readonly skills: Promise<Skills["Service"]>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    const dropLegacyChannels = () => sql.exec(`DROP TABLE IF EXISTS channels`);
    dropLegacyChannels();
    sql.exec(
      `CREATE TABLE IF NOT EXISTS agents (
         id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
         role TEXT NOT NULL DEFAULT '', persona TEXT NOT NULL DEFAULT '',
         tools TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL,
         last_active INTEGER NOT NULL DEFAULT 0)`,
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
    sql.exec(
      `CREATE TABLE IF NOT EXISTS web_threads (
         id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL,
         preview TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL,
         updated INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0)`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS web_threads_updated ON web_threads (archived, updated DESC)`,
    );
    const isFreshInstall = sql.exec(`SELECT 1 FROM agents LIMIT 1`).toArray().length === 0;
    if (isFreshInstall) {
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
    const webRow = sql
      .exec<AgentRow>(`SELECT ${COLUMNS} FROM agents WHERE slug = 'web'`)
      .toArray()[0];
    let webId = webRow?.id;
    if (webId === undefined) {
      webId = randomId();
      sql.exec(
        `INSERT INTO agents (id, slug, name, role, persona, tools, created)
         VALUES (?, 'web', ?, ?, ?, '', ?)`,
        webId,
        `${env.AGENT_NAME || "Mizook"} Web`.slice(0, 64),
        WEB_ROLE,
        WEB_PERSONA,
        Date.now(),
      );
    }
    const savedWebDefault = sql
      .exec<{ value: string }>(`SELECT value FROM hub_meta WHERE key = 'default_web'`)
      .toArray()[0]?.value;
    const savedWebAgentIsStillHere =
      savedWebDefault !== undefined &&
      sql.exec(`SELECT 1 FROM agents WHERE id = ?`, savedWebDefault).toArray().length > 0;
    if (!savedWebAgentIsStillHere)
      sql.exec(
        `INSERT INTO hub_meta (key, value) VALUES ('default_web', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        webId,
      );
    const hubSqlDriver: SqlDriver = {
      all: <T>(query: string, ...params: unknown[]) =>
        sql.exec(query, ...(params as never[])).toArray() as T[],
    };
    this.skills = Effect.runPromise(
      Skills.use(Effect.succeed).pipe(Effect.provide(Skills.layer(hubSqlDriver))),
    );
    const republishMenu = this.syncMenu();
    ctx.waitUntil(republishMenu);
  }

  private get defaultId(): string {
    return this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM hub_meta WHERE key = 'default'`)
      .one().value;
  }

  private get webDefaultId(): string {
    const saved = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM hub_meta WHERE key = 'default_web'`)
      .toArray()[0]?.value;
    return saved !== undefined && this.row(saved) !== undefined ? saved : this.defaultId;
  }

  webDefaultAgent(): AgentInfo {
    return this.agent(this.webDefaultId)!;
  }

  private info(row: AgentRow): AgentInfo {
    const bound = this.ctx.storage.sql
      .exec<{ place: string }>(`SELECT place FROM bindings WHERE agent_id = ?`, row.id)
      .toArray()
      .map((b) => b.place);
    const tools = parseStringList(row.tools) ?? EVERY_TOOL;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      role: row.role,
      persona: row.persona,
      tools,
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
        `SELECT ${COLUMNS} FROM agents WHERE id = ? OR slug = ?`,
        key,
        key.toLowerCase(),
      )
      .toArray()[0];
  }

  private async syncMenu(): Promise<void> {
    if (!this.env.BOT_TOKEN) return;
    const commands = menuWith(this.agents());
    await Effect.runPromise(
      HttpClient.execute(
        HttpClientRequest.post(
          `https://api.telegram.org/bot${this.env.BOT_TOKEN}/setMyCommands`,
        ).pipe(HttpClientRequest.bodyJsonUnsafe({ commands })),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.catch((error) => Effect.logError("setMyCommands failed", error)),
      ),
    );
  }

  agents(): AgentInfo[] {
    return this.ctx.storage.sql
      .exec<AgentRow>(`SELECT ${COLUMNS} FROM agents ORDER BY created`)
      .toArray()
      .map((row) => this.info(row));
  }

  agent(key: string): AgentInfo | undefined {
    const row = this.row(key);
    return row && this.info(row);
  }

  private webThreadInfo(row: WebThreadRow): WebThreadInfo | undefined {
    const agent = this.agent(row.agent_id);
    return agent === undefined
      ? undefined
      : {
          id: row.id,
          agent,
          title: row.title,
          preview: row.preview,
          created: row.created,
          updated: row.updated,
          archived: row.archived === 1,
        };
  }

  private webThreadRow(id: string): WebThreadRow | undefined {
    return this.ctx.storage.sql
      .exec<WebThreadRow>(
        `SELECT id, agent_id, title, preview, created, updated, archived
         FROM web_threads WHERE id = ?`,
        id,
      )
      .toArray()[0];
  }

  webThreads(): WebThreadInfo[] {
    return this.ctx.storage.sql
      .exec<WebThreadRow>(
        `SELECT id, agent_id, title, preview, created, updated, archived
         FROM web_threads WHERE archived = 0 ORDER BY updated DESC`,
      )
      .toArray()
      .flatMap((row) => {
        const info = this.webThreadInfo(row);
        return info === undefined ? [] : [info];
      });
  }

  webThread(id: string): WebThreadInfo | undefined {
    const row = this.webThreadRow(id);
    return row && this.webThreadInfo(row);
  }

  private badSpec(spec: Partial<AgentSpec>, id?: string): string | undefined {
    if (spec.slug !== undefined) {
      if (!AGENT_SLUG.test(spec.slug))
        return "slug: lowercase letters, digits and _, 2 to 32, starting with a letter";
      if (RESERVED_COMMANDS.has(spec.slug)) return `/${spec.slug} is already a command`;
      const taken = this.row(spec.slug);
      if (taken && taken.id !== id) return `${spec.slug} is taken`;
    }
    if (spec.name !== undefined && (spec.name.trim() === "" || spec.name.length > 64))
      return "name: 1 to 64 characters";
    if (spec.role !== undefined && spec.role.length > 8_000) return "role: up to 8,000 characters";
    if (spec.persona !== undefined && spec.persona.length > 8_000)
      return "persona: up to 8,000 characters";
    return undefined;
  }

  async createAgent(spec: AgentSpec): Promise<AgentChange> {
    const bad = this.badSpec(spec);
    if (bad) return { ok: false, error: bad };
    const id = randomId();
    this.ctx.storage.sql.exec(
      `INSERT INTO agents (id, slug, name, role, persona, tools, created) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      spec.slug,
      spec.name.trim(),
      spec.role,
      spec.persona,
      spec.tools == null ? "" : JSON.stringify(spec.tools),
      Date.now(),
    );
    await this.syncMenu();
    return { ok: true, agent: this.agent(id)! };
  }

  async updateAgent(key: string, patch: Partial<AgentSpec>): Promise<AgentChange> {
    const row = this.row(key);
    if (!row) return { ok: false, error: `no agent "${key}"` };
    const bad = this.badSpec(patch, row.id);
    if (bad) return { ok: false, error: bad };
    const next = {
      slug: patch.slug ?? row.slug,
      name: patch.name?.trim() ?? row.name,
      role: patch.role ?? row.role,
      persona: patch.persona ?? row.persona,
      tools:
        patch.tools === undefined
          ? row.tools
          : patch.tools === null
            ? ""
            : JSON.stringify(patch.tools),
    };
    this.ctx.storage.sql.exec(
      `UPDATE agents SET slug = ?, name = ?, role = ?, persona = ?, tools = ? WHERE id = ?`,
      next.slug,
      next.name,
      next.role,
      next.persona,
      next.tools,
      row.id,
    );
    if (next.slug !== row.slug || next.name !== row.name || next.role !== row.role)
      await this.syncMenu();
    return { ok: true, agent: this.agent(row.id)! };
  }

  async deleteAgent(key: string): Promise<AgentChange> {
    const row = this.row(key);
    if (!row) return { ok: false, error: `no agent "${key}"` };
    if (row.id === this.defaultId)
      return { ok: false, error: "the default agent cannot be deleted" };
    const gone = this.info(row);
    const wasWebDefault = row.id === this.webDefaultId;
    this.ctx.storage.sql.exec(`DELETE FROM bindings WHERE agent_id = ?`, row.id);
    this.ctx.storage.sql.exec(
      `UPDATE web_threads SET archived = 1, updated = ? WHERE agent_id = ?`,
      Date.now(),
      row.id,
    );
    if (wasWebDefault)
      this.ctx.storage.sql.exec(
        `UPDATE hub_meta SET value = ? WHERE key = 'default_web'`,
        this.defaultId,
      );
    this.ctx.storage.sql.exec(`DELETE FROM agents WHERE id = ?`, row.id);
    const target = this.env.AgentObject.getByName(gone.doName) as unknown as {
      destroy(): Promise<void>;
    };
    await Effect.runPromise(
      Effect.tryPromise(() => target.destroy()).pipe(
        Effect.catch((error) => Effect.logError(`destroying ${gone.slug} failed`, error)),
      ),
    );
    await this.syncMenu();
    return { ok: true, agent: gone };
  }

  route(place: string, command: string | undefined, agentId: string | undefined): AgentInfo {
    const bound = this.ctx.storage.sql
      .exec<{ agent_id: string }>(`SELECT agent_id FROM bindings WHERE place = ?`, place)
      .toArray()[0];
    const row =
      (agentId !== undefined ? this.row(agentId) : undefined) ??
      (command !== undefined && !RESERVED_COMMANDS.has(command) ? this.row(command) : undefined) ??
      (bound && this.row(bound.agent_id)) ??
      this.row(place.startsWith("web:") ? this.webDefaultId : this.defaultId)!;
    this.ctx.storage.sql.exec(`UPDATE agents SET last_active = ? WHERE id = ?`, Date.now(), row.id);
    return this.info(row);
  }

  bind(place: string, key: string | undefined): AgentInfo | undefined {
    if (key === undefined) {
      this.ctx.storage.sql.exec(`DELETE FROM bindings WHERE place = ?`, place);
      return this.agent(place.startsWith("web:") ? this.webDefaultId : this.defaultId);
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

  private async withSkills<A>(f: (skills: Skills["Service"]) => Effect.Effect<A, unknown>) {
    return Effect.runPromise(f(await this.skills));
  }

  skillList(): Promise<ReadonlyArray<Skill>> {
    return this.withSkills((s) => s.list);
  }

  skillGet(name: string): Promise<Skill | undefined> {
    return this.withSkills((s) => s.get(name));
  }

  skillSave(name: string, description: string, body: string): Promise<Skill> {
    return this.withSkills((s) => s.save(name, description, body));
  }

  skillRemove(name: string): Promise<boolean> {
    return this.withSkills((s) => s.remove(name));
  }

  skillTouch(name: string): Promise<void> {
    return this.withSkills((s) => s.touch(name));
  }

  skillPin(name: string): Promise<void> {
    return this.withSkills((s) => s.pin(name));
  }

  profile(): Profile {
    const row = this.ctx.storage.sql
      .exec<{ about: string; rules: string }>(`SELECT about, rules FROM profile WHERE id = 1`)
      .toArray()[0];
    if (!row) return { about: "", rules: [] };
    const rules = parseStringList(row.rules) ?? [];
    return { about: row.about, rules };
  }

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
