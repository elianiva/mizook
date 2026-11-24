import { DurableObject } from "cloudflare:workers";
import { type Context, Effect } from "effect";
import { Agent } from "./agent.ts";
import { Backup } from "./backup.ts";
import { Bot, RECOVER_AFTER_MS } from "./bot.ts";
import type { Env } from "./env.ts";
import { StateError, ToolError } from "./errors.ts";
import { EMPTY_PROFILE, Host, shortPlace, type AgentInfo, type AutomationsApi } from "./host.ts";
import type { Skills } from "./skills.ts";
import { makeRuntime, type AppRuntime } from "./runtime.ts";
import { agentObject, automationsObject, hubObject } from "./objects.ts";
import { Usage, type Spend } from "./usage.ts";
import { Artifacts } from "./artifacts.ts";
import { Commands } from "./commands.ts";
import { State } from "./state.ts";
import { Approvals } from "./approvals.ts";
import { WebThreads } from "./chat/threads.ts";
import type { WebState, WebStatus, WebTurnResult } from "./chat/types.ts";
import * as read from "./admin/read.ts";
import { edit as applyEdit, type EditOutcome } from "./admin/edit.ts";

const RELOAD_DELAY_MS = 1_500;

type Hosted = Context.Service.Shape<typeof Host>;

type HubStub = ReturnType<typeof hubObject>;

const automationsApi = (rpc: () => ReturnType<typeof automationsObject>): AutomationsApi => {
  return {
    create: (spec, action) =>
      Effect.promise(() => rpc().create(spec, action)).pipe(
        Effect.flatMap((change) =>
          change.ok
            ? Effect.succeed(change.automation)
            : Effect.fail(new ToolError({ reason: change.error })),
        ),
      ),
    list: (agent) => Effect.promise(() => rpc().list(agent)),
    cancel: (id) => Effect.promise(() => rpc().cancel(id)),
    pause: (id) => Effect.promise(() => rpc().pause(id)),
    resume: (id) =>
      Effect.promise(() => rpc().resume(id)).pipe(
        Effect.flatMap((r) =>
          r.error === undefined
            ? Effect.succeed(r.ok)
            : Effect.fail(new ToolError({ reason: r.error })),
        ),
      ),
    test: (id) => Effect.promise(() => rpc().test(id)),
    hookUrl: (id) => Effect.promise(() => rpc().hookUrl(id)),
    runs: (limit, automationId) => Effect.promise(() => rpc().runs(limit, automationId)),
  };
};

const hubSkillsAsAgentSkills = (hub: () => HubStub): Skills["Service"] => {
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

export class AgentObject extends DurableObject<Env> {
  private runtime!: AppRuntime;
  private self!: AgentInfo;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const resumeInterruptedWork = () => this.alarm();
    const initialise = async () => {
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
    };
    void Effect.runPromise(
      Effect.promise(() => ctx.blockConcurrencyWhile(initialise)).pipe(
        Effect.andThen(Effect.promise(resumeInterruptedWork)),
      ),
    );
  }

  private get doName(): string {
    return this.ctx.id.name ?? "agent:main";
  }

  private hub(): HubStub {
    return hubObject(this.env);
  }

  private reloadRuntimeAfterReply(): void {
    const old = this.runtime;
    this.ctx.waitUntil(
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, RELOAD_DELAY_MS));
        await old.dispose();
        this.self = (await this.hub().agent(this.self.id)) ?? this.self;
        this.runtime = makeRuntime(this.ctx.storage, this.env, this.host());
        await this.runtime.runPromise(Effect.void);
      })(),
    );
  }

  private host(): Hosted {
    const hub = () => this.hub();
    const self = this.self;
    const reload = () => this.reloadRuntimeAfterReply();
    const exportLink = this.runtimeEffect(Backup.use((backup) => backup.exportLink));
    const peer = (doName: string) => agentObject(this.env, doName);
    return {
      self,
      reload: Effect.sync(reload),
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
      globalSkills: hubSkillsAsAgentSkills(hub),
      profile: Effect.tryPromise({ try: () => hub().profile(), catch: () => undefined }).pipe(
        Effect.orElseSucceed(() => EMPTY_PROFILE),
      ),
      updateProfile: (about, rules) =>
        Effect.tryPromise({
          try: () => hub().setProfile(about, rules === undefined ? undefined : [...rules]),
          catch: (cause) => new StateError({ operation: "profile", cause }),
        }),
      automations: automationsApi(() => automationsObject(this.env)),
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

  async reload(): Promise<void> {
    this.reloadRuntimeAfterReply();
  }

  async destroy(): Promise<void> {
    await this.runtime.dispose();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async ask(question: string): Promise<string> {
    return this.runtime.runPromise(Agent.use((agent) => agent.ask(question)));
  }

  async runTurn(place: string, text: string, requestId: string): Promise<string> {
    const reply = this.runtime.runPromise(Bot.use((bot) => bot.turn(place, text, requestId)));
    await this.rearmAlarm();
    return reply;
  }

  async webTurn(
    place: string,
    text: string,
    requestId: string,
    where: string,
    first: boolean,
  ): Promise<WebTurnResult> {
    return this.runtime.runPromise(
      Bot.use((bot) => bot.beginWebTurn(place, text, requestId, where, first)).pipe(
        Effect.tap(Effect.promise(() => this.rearmAlarm())),
        Effect.catchCause((cause) =>
          Effect.as(Effect.logError("web turn failed to start", cause), {
            ok: false as const,
            reason: "The turn could not start. Try again.",
          }),
        ),
      ),
    );
  }

  async webStatus(place: string): Promise<WebStatus> {
    const [running, approvals] = await Promise.all([
      this.runtime.runPromise(
        Agent.use((agent) =>
          Effect.map(agent.pending, (turns) => turns.some((turn) => turn.chatId === place)),
        ),
      ),
      this.runtime.runPromise(Approvals.use((pending) => pending.unposted(place))),
    ]);
    return {
      running,
      approvals: approvals.map(({ id, summary, match, created }) => ({
        id,
        summary,
        match,
        created,
      })),
    };
  }

  async webState(place: string, after = 0): Promise<WebState> {
    const [messages, status] = await Promise.all([
      this.runtime.runPromise(WebThreads.use((threads) => threads.messages(place, after))),
      this.webStatus(place),
    ]);
    return { messages, ...status };
  }

  async webStop(place: string): Promise<boolean> {
    return this.runtime.runPromise(
      Agent.use((agent) => agent.stop(place)).pipe(
        Effect.catchCause((cause) =>
          Effect.as(Effect.logError("stopping a web turn failed", cause), false),
        ),
      ),
    );
  }

  async postTo(place: string, text: string): Promise<void> {
    await this.runtime.runPromise(Bot.use((bot) => bot.postTo(place, text)));
  }

  async spend(): Promise<Spend> {
    return this.runtime.runPromise(Usage.use((usage) => usage.spend));
  }

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
      case "skills":
        return read.skills(sql);
      case "intents":
        return read.intents(sql);
      case "policies":
        return read.policies(sql);
      case "audit":
        return read.audit(sql);
      case "artifacts":
        return this.runtime.runPromise(Artifacts.use((artifacts) => artifacts.list));
      case "artifact":
        return this.runtime.runPromise(
          Artifacts.use((artifacts) => artifacts.source(params.name ?? "")).pipe(
            Effect.catchCause(() => Effect.undefined),
          ),
        );
      default:
        return undefined;
    }
  }

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
    await this.runtime.runPromise(
      State.use((state) =>
        state.audit(who, `agent:${kind}:${action}${label}`, target, result.ok),
      ).pipe(Effect.ignoreCause),
    );
    return result;
  }

  async act(who: string, action: string, id: number): Promise<boolean> {
    const done = await this.runtime.runPromise(
      Effect.gen(function* () {
        const bot = yield* Bot;
        if (action === "approve" || action === "deny" || action === "always") {
          const pending = yield* bot.approve(id, action !== "deny", action === "always");
          if (!pending) return { ok: false, after: undefined };
          return { ok: true, after: pending.resume };
        }
        return { ok: false, after: undefined };
      }),
    );
    await this.runtime.runPromise(State.use((state) => state.audit(who, action, id, done.ok)));
    if (done.after) {
      const resumeExecutorThenTurn = done.after;
      this.ctx.waitUntil(
        this.runtime.runPromise(
          resumeExecutorThenTurn.pipe(Effect.andThen(Effect.promise(() => this.rearmAlarm()))),
        ),
      );
    }
    return done.ok;
  }

  async artifact(who: string, name: string, action: string): Promise<boolean> {
    const ok = await this.runtime.runPromise(
      Artifacts.use((artifacts) =>
        action === "delete"
          ? artifacts.remove(this.doName, name)
          : Effect.as(
              artifacts.setVisibility(name, action === "private" ? "private" : "public"),
              true,
            ),
      ).pipe(Effect.catchCause(() => Effect.succeed(false))),
    );
    await this.runtime.runPromise(
      State.use((state) => state.audit(who, `artifact:${action}:${name}`, 0, ok)),
    );
    return ok;
  }

  async publishArtifact(
    who: string,
    name: string,
    content: string,
    contentType: string,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const result = await this.runtime.runPromise(
      Artifacts.use((artifacts) => artifacts.publish(this.doName, name, content, contentType)).pipe(
        Effect.match({
          onSuccess: (made) => ({ ok: true as const, url: made.url }),
          onFailure: (e) => ({
            ok: false as const,
            error: "reason" in e ? e.reason : "Could not save it",
          }),
        }),
        Effect.catchCause(() => Effect.succeed({ ok: false as const, error: "Could not save it" })),
      ),
    );
    await this.runtime.runPromise(
      State.use((state) => state.audit(who, `artifact:create:${name}`, 0, result.ok)),
    );
    return result;
  }

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
    await this.rearmAlarm();
    return response;
  }

  override async alarm(): Promise<void> {
    const attempt = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
      this.runtime.runPromise(
        (effect as Effect.Effect<A, E, never>).pipe(
          Effect.catchCause((cause) => Effect.logError(`${label} failed`, cause)),
        ),
      );
    await attempt(
      "recovery",
      Bot.use((bot) => bot.recover),
    );
    await attempt(
      "backup",
      Backup.use((backup) => backup.backupIfDue(Date.now())),
    );
    await this.rearmAlarm();
  }

  private async rearmAlarm(): Promise<void> {
    const storage = this.ctx.storage;
    await this.runtime.runPromise(
      Effect.gen(function* () {
        const times = yield* Effect.all([
          Bot.use((bot) => bot.nextWake).pipe(
            Effect.catchCause(() => Effect.succeed(Date.now() + RECOVER_AFTER_MS)),
          ),
          Backup.use((backup) => backup.nextBackupAt).pipe(
            Effect.catchCause(() => Effect.undefined),
          ),
        ]);
        const at = times.filter((t): t is number => t !== undefined);
        if (at.length > 0) yield* Effect.promise(() => storage.setAlarm(Math.min(...at)));
      }),
    );
  }
}
