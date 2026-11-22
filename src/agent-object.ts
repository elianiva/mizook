import { DurableObject } from "cloudflare:workers";
import { type Context, Effect } from "effect";
import { Agent } from "./agent.ts";
import { Backup } from "./backup.ts";
import { Bot, RECOVER_AFTER_MS } from "./bot.ts";
import type { Env } from "./env.ts";
import { StateError, ToolError } from "./errors.ts";
import {
  EMPTY_PROFILE,
  Host,
  shortPlace,
  type AgentChange,
  type AgentInfo,
  type AgentSpec,
  type Profile,
} from "./host.ts";
import type { Skill, Skills } from "./skills.ts";
import { makeRuntime, type AppRuntime } from "./runtime.ts";
import { hookToken } from "./hooks.ts";
import { Usage, type Spend } from "./usage.ts";
import { Schedules } from "./schedules.ts";
import { Artifacts } from "./artifacts.ts";
import { Commands } from "./commands.ts";
import { State } from "./state.ts";
import * as read from "./admin/read.ts";
import { edit as applyEdit, type EditOutcome } from "./admin/edit.ts";

type Hosted = Context.Service.Shape<typeof Host>;

/** The Hub's methods, spelled out: its stub type loops back through `Env`. */
export interface HubApi {
  agents(): Promise<AgentInfo[]>;
  createAgent(spec: AgentSpec): Promise<AgentChange>;
  updateAgent(key: string, patch: Partial<AgentSpec>): Promise<AgentChange>;
  deleteAgent(key: string): Promise<AgentChange>;
  skillList(): Promise<ReadonlyArray<Skill>>;
  skillGet(name: string): Promise<Skill | undefined>;
  skillSave(name: string, description: string, body: string): Promise<Skill>;
  skillRemove(name: string): Promise<boolean>;
  skillTouch(name: string): Promise<void>;
  skillPin(name: string): Promise<void>;
  agent(key: string): Promise<AgentInfo | undefined>;
  route(
    place: string,
    command: string | undefined,
    agentId: string | undefined,
  ): Promise<AgentInfo>;
  bind(place: string, key: string | undefined): Promise<AgentInfo | undefined>;
  placeName(place: string): Promise<string | undefined>;
  setPlaceName(place: string, name: string): Promise<void>;
  profile(): Promise<Profile>;
  setProfile(about: string | undefined, rules: string[] | undefined): Promise<Profile>;
}

interface AgentApi {
  ask(question: string): Promise<string>;
  spend(): Promise<Spend>;
  setting(who: string, key: string, value: string | undefined): Promise<string>;
  reload(): Promise<void>;
}

/** The Hub's skills behind the same interface as an agent's own. */
const globalSkills = (hub: () => HubApi): Skills["Service"] => {
  const call = <A>(operation: string, f: () => Promise<A>) =>
    Effect.tryPromise({ try: f, catch: (cause) => new StateError({ operation, cause }) });
  return {
    list: call("global skills", () => hub().skillList()),
    get: (name) => call("global skill", () => hub().skillGet(name)),
    save: (name, description, body) =>
      call("save global skill", () => hub().skillSave(name, description, body)),
    remove: (name) => call("remove global skill", () => hub().skillRemove(name)),
    touch: (name) => call("touch global skill", () => hub().skillTouch(name)),
    pin: (name) => call("pin global skill", () => hub().skillPin(name)),
    setPinned: (name, pinned) =>
      pinned ? call("pin global skill", () => hub().skillPin(name)) : Effect.void,
    index: Effect.map(
      call("global skills", () => hub().skillList()),
      (all) => all.map(({ name, description }) => ({ name, description })),
    ),
  };
};

/**
 * One agent: its memory, pi-durable, schedules, skills and settings, in one Durable Object with one
 * SQLite, named `agent:<id>`. It answers in every Telegram place bound to it, and in any place
 * where someone invokes it with `/<slug>`.
 */
export class AgentObject extends DurableObject<Env> {
  private runtime!: AppRuntime;
  private self!: AgentInfo;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Read who this agent is, then build the layers (open the storage, resume what a restart
    // interrupted) before any request. Delivering a turn can take minutes, so work starts after
    // this, not inside it: the gate has 30 seconds.
    void ctx
      .blockConcurrencyWhile(async () => {
        const id = this.doName.replace(/^agent:/, "");
        this.self = (await this.hub().agent(id)) ?? {
          id,
          slug: id,
          name: env.AGENT_NAME || "Mizook",
          role: "",
          persona: "",
          tools: undefined,
          doName: this.doName,
          isDefault: false,
          bound: [],
          created: 0,
          lastActive: 0,
        };
        this.runtime = makeRuntime(ctx.storage, env, this.host());
        await this.runtime.runPromise(Effect.void);
      })
      .then(() => this.alarm());
  }

  private get doName(): string {
    return this.ctx.id.name ?? "agent:main";
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
        this.self = (await this.hub().agent(this.self.id)) ?? this.self;
        this.runtime = makeRuntime(this.ctx.storage, this.env, this.host());
        await this.runtime.runPromise(Effect.void);
      })(),
    );
  }

  /** What this agent can ask of the world outside it. */
  private host(): Hosted {
    const hub = () => this.hub();
    const self = this.self;
    const reload = () => this.reloadRuntime();
    const exportLink = this.runtimeEffect(Backup.use((backup) => backup.exportLink));
    const peer = (doName: string) => this.env.AgentObject.getByName(doName) as unknown as AgentApi;
    return {
      self,
      reload: Effect.sync(reload),
      hookUrl: Effect.promise(async () => {
        const token = await hookToken(this.env.MIZOOK_WEBHOOK_SECRET, self.doName);
        return `${this.env.PUBLIC_URL ?? ""}/hook/${encodeURIComponent(self.doName)}/${token}`;
      }),
      agents: Effect.promise(() => hub().agents()),
      bind: (place, slug) => Effect.promise(() => hub().bind(place, slug)),
      placeLabel: (place) =>
        Effect.tryPromise(() => hub().placeName(place)).pipe(
          Effect.map((name) => name ?? shortPlace(place)),
          Effect.orElseSucceed(() => shortPlace(place)),
        ),
      namePlace: (place, name) => Effect.promise(() => hub().setPlaceName(place, name)),
      createAgent: (spec) => Effect.promise(() => hub().createAgent(spec)),
      updateAgent: (key, patch) => Effect.promise(() => hub().updateAgent(key, patch)),
      deleteAgent: (key) => Effect.promise(() => hub().deleteAgent(key)),
      setAgentSetting: (doName, key, value) =>
        Effect.promise(() =>
          doName === self.doName
            ? this.setting(`agent:${self.slug}`, key, value)
            : peer(doName).setting(`agent:${self.slug}`, key, value),
        ).pipe(Effect.asVoid),
      reloadAgent: (doName) =>
        doName === self.doName ? Effect.sync(reload) : Effect.promise(() => peer(doName).reload()),
      globalSkills: globalSkills(hub),
      profile: Effect.tryPromise({ try: () => hub().profile(), catch: () => undefined }).pipe(
        Effect.orElseSucceed(() => EMPTY_PROFILE),
      ),
      updateProfile: (about, rules) =>
        Effect.tryPromise({
          try: () => hub().setProfile(about, rules === undefined ? undefined : [...rules]),
          catch: (cause) => new StateError({ operation: "profile", cause }),
        }),
      testSchedule: (id) => Effect.sync(() => this.scheduleTest(id)),
      ask: (agent, question) =>
        Effect.gen(function* () {
          const all = yield* Effect.promise(() => hub().agents());
          const wanted = agent.trim().replace(/^\//, "").toLowerCase();
          const found = all.find((a) => a.slug === wanted || a.name.toLowerCase() === wanted);
          if (!found) {
            return yield* new ToolError({
              reason: `no agent "${agent}". Agents: ${all.map((a) => a.slug).join(", ")}`,
            });
          }
          if (found.id === self.id) {
            return yield* new ToolError({ reason: "that is you: use your own memory" });
          }
          return yield* Effect.tryPromise({
            try: () => peer(found.doName).ask(question),
            catch: (cause) =>
              new ToolError({ reason: `asking ${found.slug} failed: ${String(cause)}` }),
          });
        }),
      spendAll: Effect.gen(function* () {
        const all = yield* Effect.promise(() => hub().agents());
        return yield* Effect.forEach(all, (a) =>
          Effect.promise(() => peer(a.doName).spend()).pipe(
            Effect.map((spend) => ({ name: a.slug, spend })),
          ),
        );
      }),
      exportNow: exportLink,
    };
  }

  private runtimeEffect<A, E>(effect: Effect.Effect<A, E, Backup>): Effect.Effect<A> {
    return Effect.promise(() => this.runtime.runPromise(effect as never) as Promise<A>);
  }

  /** Its config changed in the Hub: read it again. */
  async reload(): Promise<void> {
    this.reloadRuntime();
  }

  /** The Hub deleted this agent: drop everything it stored. */
  async destroy(): Promise<void> {
    await this.runtime.dispose();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Called by another agent through `ask_agent`: read-only, nothing is logged here. */
  async ask(question: string): Promise<string> {
    return this.runtime.runPromise(Agent.use((agent) => agent.ask(question)));
  }

  /** A webhook call, already checked by the Worker. */
  async hook(body: string): Promise<boolean> {
    return this.runtime.runPromise(Bot.use((bot) => bot.hook(body)));
  }

  /** Start a test run in the background; the result posts to the chat like a scheduled turn. */
  scheduleTest(id: number): boolean {
    this.ctx.waitUntil(
      this.runtime.runPromise(Bot.use((bot) => bot.testSchedule(id))).catch(() => undefined),
    );
    return true;
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
      case "skills":
        return read.skills(sql);
      case "intents":
        return read.intents(sql);
      case "policies":
        return read.policies(sql);
      case "runs":
        return read.runs(sql, Math.min(Number(params.limit) || 25, 50));
      case "audit":
        return read.audit(sql);
      case "artifacts":
        return this.runtime.runPromise(Artifacts.use((artifacts) => artifacts.list));
      case "artifact":
        return this.runtime
          .runPromise(Artifacts.use((artifacts) => artifacts.source(params.name ?? "")))
          .catch(() => undefined);
      default:
        return undefined;
    }
  }

  /** Apply a dashboard edit to the profile, a skill, an intent or a policy. Audited. */
  async edit(who: string, kind: string, input: unknown): Promise<EditOutcome> {
    const result = await this.runtime.runPromise(
      applyEdit(kind, input).pipe(
        Effect.match({
          onSuccess: (outcome) => outcome,
          onFailure: (error) => ({ ok: false as const, error: error.message }),
        }),
      ),
    );
    const data =
      input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const action = typeof data.action === "string" ? data.action : "save";
    const label =
      kind === "skills" && typeof data.name === "string" && data.name !== "" ? `:${data.name}` : "";
    const target = kind === "intents" || kind === "policies" ? Number(data.id) || 0 : 0;
    await this.runtime
      .runPromise(
        State.use((state) =>
          state.audit(who, `agent:${kind}:${action}${label}`, target, result.ok),
        ),
      )
      .catch(() => undefined);
    return result;
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

  /** Change or remove a published artifact from the dashboard. Audited. False when it is gone. */
  async artifact(who: string, name: string, action: string): Promise<boolean> {
    const ok = await this.runtime
      .runPromise(
        Artifacts.use((artifacts) =>
          action === "delete"
            ? artifacts.remove(this.doName, name)
            : Effect.as(
                artifacts.setVisibility(name, action === "private" ? "private" : "public"),
                true,
              ),
        ),
      )
      .catch(() => false);
    await this.runtime.runPromise(
      State.use((state) => state.audit(who, `artifact:${action}:${name}`, 0, ok)),
    );
    return ok;
  }

  /** Publish a page the person pasted into the dashboard. Audited. */
  async publishArtifact(
    who: string,
    name: string,
    content: string,
    contentType: string,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const result = await this.runtime
      .runPromise(
        Artifacts.use((artifacts) =>
          artifacts.publish(this.doName, name, content, contentType),
        ).pipe(
          Effect.match({
            onSuccess: (made) => ({ ok: true as const, url: made.url }),
            onFailure: (e) => ({
              ok: false as const,
              error: "reason" in e ? e.reason : "Could not save it",
            }),
          }),
        ),
      )
      .catch(() => ({ ok: false as const, error: "Could not save it" }));
    await this.runtime.runPromise(
      State.use((state) => state.audit(who, `artifact:create:${name}`, 0, result.ok)),
    );
    return result;
  }

  /** Stop every turn that is running, as `/stop` does in each place. */
  async stop(who: string): Promise<boolean> {
    const stopped = await this.runtime.runPromise(
      Effect.gen(function* () {
        const agent = yield* Agent;
        const turns = yield* agent.pending;
        const done = yield* Effect.forEach(turns, (turn) => agent.stop(turn.chatId));
        return done.some(Boolean);
      }),
    );
    await this.runtime.runPromise(State.use((state) => state.audit(who, "stop", 0, stopped)));
    return stopped;
  }

  /**
   * Change one of this agent's settings the way its slash command does, so the checks and the
   * reload are the command's own. `undefined` resets it. Returns the command's reply.
   */
  async setting(who: string, key: string, value: string | undefined): Promise<string> {
    const reply = await this.runtime.runPromise(
      Effect.gen(function* () {
        const text = `/${key} ${value === undefined ? "reset" : value}`;
        return (yield* (yield* Commands).run("dashboard", text)) ?? "Unknown setting.";
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
