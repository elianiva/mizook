import { Effect } from "effect";
import type { Env } from "../env.ts";
import type { AgentInfo, Profile } from "../host.ts";
import { KIND_TYPES } from "../artifact-render.ts";
import type { AutomationsObject } from "../automations-object.ts";
import { makeVerifier, type Verifier } from "./access.ts";

interface ChannelRpc {
  dashboard(page: string, params: Record<string, string>): Promise<unknown>;
  act(who: string, action: string, id: number): Promise<boolean>;
  stop(who: string): Promise<boolean>;
  artifact(who: string, name: string, action: string): Promise<boolean>;
  publishArtifact(
    who: string,
    name: string,
    content: string,
    contentType: string,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  edit(
    who: string,
    kind: string,
    input: unknown,
  ): Promise<{ ok: true; said: string } | { ok: false; error: string }>;
  setting(who: string, key: string, value: string | undefined): Promise<string>;
}

let verifier: { key: string; value: Verifier } | undefined;
const verifierFor = (env: Env): Verifier | undefined => {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return undefined;
  const key = `${env.ACCESS_TEAM_DOMAIN}|${env.ACCESS_AUD}`;
  if (verifier?.key !== key)
    verifier = {
      key,
      value: makeVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }),
    };
  return verifier.value;
};

const PAGES = new Set([
  "overview",
  "messages",
  "message",
  "memory",
  "usage",
  "schedules",
  "skills",
  "intents",
  "policies",
  "runs",
  "audit",
  "artifacts",
  "artifact",
]);

/** An agent in the shape the dashboard lists: until its pages are per agent, each agent is one row. */
const asChannel = (a: AgentInfo) => ({
  doName: a.doName,
  threadId: a.slug,
  name: a.name,
  lastActive: a.lastActive,
});

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** What the app may load: itself, its own API, and nothing from anywhere else. */
const SHELL_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** The automations Durable Object, as the dashboard reads it. */
const automationsOf = (env: Env) =>
  env.Automations.getByName("automations") as unknown as AutomationsObject;

/**
 * An agent's automations and their runs, in the shapes the dashboard's schedule pages read. The
 * per-agent pages are rebuilt with the web UI; until then each automation is a schedule row.
 */
const agentAutomations = async (env: Env, agent: AgentInfo, page: "schedules" | "runs") => {
  const mine = await automationsOf(env).list(agent.id);
  if (page === "schedules")
    return mine
      .filter((a) => a.active)
      .map((a) => ({
        id: a.id,
        spec: JSON.stringify(a.spec),
        prompt:
          a.action.kind === "turn"
            ? a.action.prompt
            : a.action.kind === "post"
              ? a.action.text
              : `${a.action.method} ${a.action.url}`,
        nextAt: a.spec.kind === "webhook" ? 0 : a.nextAt,
      }));
  const ids = new Set(mine.map((a) => a.id));
  return (await automationsOf(env).runs(50))
    .filter((r) => ids.has(r.automationId))
    .slice(0, 25)
    .map((r) => ({
      id: r.id,
      scheduleId: r.automationId,
      status: r.status,
      started: r.started,
      finished: r.finished ?? null,
      output: r.output,
      error: r.error ?? null,
    }));
};

const api = async (name: string, url: URL, env: Env): Promise<Response> => {
  const hub = env.Hub.getByName("hub") as unknown as {
    agents(): Promise<AgentInfo[]>;
    profile(): Promise<Profile>;
  };
  const agents = await hub.agents();
  const channels = agents.map(asChannel);
  if (name === "channels") return json(channels);
  if (name === "profile") return json(await hub.profile());
  if (name === "summary") {
    // One line per channel, for the overview: what each costs and what waits on a person.
    const lines = await Promise.all(
      channels.map(async (c) => {
        const rpc = env.AgentObject.getByName(c.doName) as unknown as ChannelRpc;
        const o = (await rpc.dashboard("overview", {})) as {
          messages: number;
          spend: { last24h: number; last7d: number };
          turns: unknown[];
          approvals: unknown[];
          settings: Record<string, string>;
        };
        return {
          doName: c.doName,
          name: c.name,
          lastActive: c.lastActive,
          messages: o.messages,
          spend24h: o.spend.last24h,
          spend7d: o.spend.last7d,
          pending: o.turns.length,
          approvals: o.approvals.length,
          schedules: (await automationsOf(env).list(c.doName.replace(/^agent:/, ""))).filter(
            (a) => a.active,
          ).length,
          budget: Number(o.settings["budget"]) || 0,
        };
      }),
    );
    return json(lines);
  }
  if (!PAGES.has(name)) return json({ error: "not found" }, 404);
  const wanted = url.searchParams.get("c") ?? "";
  const channel = channels.find((c) => c.doName === wanted);
  if (!channel) return json({ error: "no such channel" }, 404);
  const agent = agents.find((a) => a.doName === channel.doName)!;
  if (name === "schedules" || name === "runs")
    return json(await agentAutomations(env, agent, name));
  const rpc = env.AgentObject.getByName(channel.doName) as unknown as ChannelRpc;
  const data = await rpc.dashboard(name, Object.fromEntries(url.searchParams));
  if (name === "overview" && data !== undefined) {
    // An agent's automations live in their own Durable Object, not in its SQLite.
    const active = (await automationsOf(env).list(agent.id)).filter(
      (a) => a.active && a.spec.kind !== "webhook",
    );
    return json({
      ...(data as object),
      schedules: active.length,
      nextSchedule: active.length === 0 ? null : Math.min(...active.map((a) => a.nextAt)),
    });
  }
  return data === undefined ? json({ error: "not found" }, 404) : json(data);
};

/** The built app. Any path that is not a file gets its HTML, and the app routes it. */
const shell = async (request: Request, env: Env): Promise<Response> => {
  if (!env.ASSETS) return new Response("The dashboard is not built", { status: 503 });
  const url = new URL(request.url);
  const isFile = /\.[a-z0-9]+$/i.test(url.pathname);
  const asset = await env.ASSETS.fetch(isFile ? request : new Request(new URL("/admin/", url)));
  const response = new Response(asset.body, asset);
  response.headers.set("content-security-policy", SHELL_POLICY);
  response.headers.set("x-content-type-options", "nosniff");
  if (!isFile) response.headers.set("cache-control", "no-store");
  return response;
};

const ACTIONS: Record<string, string> = {
  approve: "approve",
  deny: "deny",
  cancel: "cancel_schedule",
};

const SETTINGS = ["model", "instructions", "timezone", "budget"];

/** What a setting may be, checked before it reaches the channel's own command. Undefined when fine. */
const badSetting = (key: string, value: string): string | undefined => {
  if (value.length > 4_000) return "That is too long";
  if (key === "budget" && !(Number.isFinite(Number(value)) && Number(value) >= 0))
    return "Give a number of dollars, 0 for none";
  if (key === "timezone") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
    } catch {
      return `${value} is not an IANA time zone`;
    }
  }
  if (key === "model" && !/^[\w.:/-]{1,120}$/.test(value)) return "That is not a model id";
  return undefined;
};

/**
 * A write. A browser sends a cross-site form post with the person's Access cookie, so besides
 * the token it must carry a header a plain form cannot set, and come from this origin.
 */
const act = async (request: Request, url: URL, who: string, env: Env): Promise<Response> => {
  if (request.headers.get("x-mizook-csrf") !== "1" || request.headers.get("origin") !== url.origin)
    return json({ error: "forbidden" }, 403);
  const hub = env.Hub.getByName("hub") as unknown as { agents(): Promise<AgentInfo[]> };
  const channel = (await hub.agents()).find((a) => a.doName === url.searchParams.get("c"));
  if (!channel) return json({ error: "no such channel" }, 404);
  const rpc = env.AgentObject.getByName(channel.doName) as unknown as ChannelRpc;

  if (url.pathname === "/admin/api/stop") {
    return (await rpc.stop(who)) ? json({ ok: true }) : json({ error: "already gone" }, 409);
  }

  if (url.pathname === "/admin/api/artifacts") {
    const body = (await request.json().catch(() => undefined)) as
      | { name?: unknown; kind?: unknown; content?: unknown }
      | undefined;
    const kind = body?.kind === "html" || body?.kind === "markdown" ? body.kind : undefined;
    if (!kind || typeof body?.name !== "string" || typeof body.content !== "string")
      return json({ error: "bad request" }, 400);
    const made = await rpc.publishArtifact(who, body.name.trim(), body.content, KIND_TYPES[kind]);
    return made.ok ? json(made) : json({ error: made.error }, 400);
  }

  const edit = /^\/admin\/api\/(profile|skills|intents|policies)$/.exec(url.pathname);
  if (edit) {
    const body = await request.json().catch(() => undefined);
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return json({ error: "bad request" }, 400);
    const result = await rpc.edit(who, edit[1]!, body);
    return result.ok ? json(result) : json(result, 400);
  }

  const artifact =
    /^\/admin\/api\/artifacts\/([a-z0-9][a-z0-9._-]{0,60})\/(public|private|delete)$/.exec(
      url.pathname,
    );
  if (artifact) {
    return (await rpc.artifact(who, artifact[1]!, artifact[2]!))
      ? json({ ok: true })
      : json({ error: "already gone" }, 409);
  }

  const setting = /^\/admin\/api\/settings\/([a-z]+)$/.exec(url.pathname);
  if (setting) {
    const key = setting[1]!;
    if (!SETTINGS.includes(key)) return json({ error: "not found" }, 404);
    const body = (await request.json().catch(() => undefined)) as { value?: unknown } | undefined;
    const value = typeof body?.value === "string" ? body.value.trim() : undefined;
    if (body === undefined || (body.value !== undefined && value === undefined))
      return json({ error: "bad request" }, 400);
    const bad = value === undefined || value === "" ? undefined : badSetting(key, value);
    if (bad) return json({ error: bad }, 400);
    return json({ ok: true, said: await rpc.setting(who, key, value === "" ? undefined : value) });
  }

  const match =
    /^\/admin\/api\/(?:approvals\/(\d+)\/(approve|deny)|schedules\/(\d+)\/(cancel))$/.exec(
      url.pathname,
    );
  const action = match && ACTIONS[(match[2] ?? match[4])!];
  if (!match || !action) return json({ error: "not found" }, 404);
  if (action === "cancel_schedule") {
    // Automations are not the agent's: only one that acts for it may be cancelled from its page.
    const id = Number(match[3]);
    const found = await automationsOf(env).get(id);
    const ownId = channel.doName.replace(/^agent:/, "");
    if (!found || found.action.kind === "webhook" || found.action.agent !== ownId)
      return json({ error: "already gone" }, 409);
    return (await automationsOf(env).cancel(id))
      ? json({ ok: true })
      : json({ error: "already gone" }, 409);
  }
  return (await rpc.act(who, action, Number(match[1] ?? match[3])))
    ? json({ ok: true })
    : json({ error: "already gone" }, 409);
};

/**
 * The dashboard. Reads are GET; writes are the POSTs of `act`. Every request must carry a token Access signed for this application,
 * checked here as well as at the edge, so a route Access does not cover still stays shut.
 */
export const handleAdmin = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  const check = verifierFor(env);
  if (!check) return new Response("The dashboard is not configured", { status: 503 });
  const who = await Effect.runPromise(
    check
      .verify(request.headers.get("cf-access-jwt-assertion"))
      .pipe(Effect.match({ onSuccess: (email) => email, onFailure: () => undefined })),
  );
  if (who === undefined) return new Response("Forbidden", { status: 403 });

  const url = new URL(request.url);
  if (request.method === "POST") return act(request, url, who, env);
  const api_ = /^\/admin\/api\/([a-z]+)$/.exec(url.pathname);
  if (api_) return api(api_[1]!, url, env);
  return shell(request, env);
};
