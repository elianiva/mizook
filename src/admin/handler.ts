import { Effect, Option, Predicate } from "effect";
import type { Env } from "../env.ts";
import type { AgentChange, AgentInfo, AgentSpec, Profile } from "../host.ts";
import { KIND_TYPES } from "../artifact-render.ts";
import type { AutomationsObject } from "../automations-object.ts";
import { verifierFor } from "./access.ts";

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

/** What the Agents page shows: an agent's identity and configuration, not its activity. */
const agentRow = (a: AgentInfo, model: string) => ({
  doName: a.doName,
  slug: a.slug,
  name: a.name,
  role: a.role,
  persona: a.persona,
  tools: a.tools ?? null,
  isDefault: a.isDefault,
  model,
  created: a.created,
  lastActive: a.lastActive,
});

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

const agentAsChannelRow = (a: AgentInfo) => ({
  doName: a.doName,
  threadId: a.slug,
  name: a.name,
  lastActive: a.lastActive,
});

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const SELF_ONLY_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const automationsOf = (env: Env) =>
  env.Automations.getByName("automations") as unknown as AutomationsObject;

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
  const channels = agents.map(agentAsChannelRow);
  if (name === "channels") return json(channels);
  if (name === "profile") return json(await hub.profile());
  if (name === "agents")
    return json(
      await Promise.all(
        agents.map(async (a) => {
          const rpc = env.AgentObject.getByName(a.doName) as unknown as ChannelRpc;
          const o = (await rpc.dashboard("overview", {})) as { settings: Record<string, string> };
          return agentRow(a, o.settings["model"] ?? "");
        }),
      ),
    );
  if (name === "summary") {
    const overviewRowPerChannel = await Promise.all(
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
    return json(overviewRowPerChannel);
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
    const activeTimedAutomations = (await automationsOf(env).list(agent.id)).filter(
      (a) => a.active && a.spec.kind !== "webhook",
    );
    return json({
      ...(data as object),
      schedules: activeTimedAutomations.length,
      nextSchedule:
        activeTimedAutomations.length === 0
          ? null
          : Math.min(...activeTimedAutomations.map((a) => a.nextAt)),
    });
  }
  return data === undefined ? json({ error: "not found" }, 404) : json(data);
};

const serveDashboardApp = async (request: Request, env: Env): Promise<Response> => {
  if (!env.ASSETS) return new Response("The dashboard is not built", { status: 503 });
  const url = new URL(request.url);
  const isStaticFileRequest = /\.[a-z0-9]+$/i.test(url.pathname);
  const asset = await env.ASSETS.fetch(
    isStaticFileRequest ? request : new Request(new URL("/admin/", url)),
  );
  const response = new Response(asset.body, asset);
  response.headers.set("content-security-policy", SELF_ONLY_CONTENT_SECURITY_POLICY);
  response.headers.set("x-content-type-options", "nosniff");
  if (!isStaticFileRequest) response.headers.set("cache-control", "no-store");
  return response;
};

const ACTIONS: Record<string, string> = {
  approve: "approve",
  deny: "deny",
  cancel: "cancel_schedule",
};

const SETTINGS = ["model", "instructions", "timezone", "budget"];

const MAX_SETTING_CHARS = 4_000;

const invalidSettingReason = (key: string, value: string): string | undefined => {
  if (value.length > MAX_SETTING_CHARS) return "That is too long";
  if (key === "budget" && !(Number.isFinite(Number(value)) && Number(value) >= 0))
    return "Give a number of dollars, 0 for none";
  if (key === "timezone") {
    const isZone = Effect.runSync(
      Effect.isSuccess(Effect.try(() => new Intl.DateTimeFormat("en", { timeZone: value }))),
    );
    if (!isZone) return `${value} is not an IANA time zone`;
  }
  if (key === "model" && !/^[\w.:/-]{1,120}$/.test(value)) return "That is not a model id";
  return undefined;
};

const bodyOf = (request: Request): Promise<unknown> =>
  Effect.runPromise(
    Effect.tryPromise(async (): Promise<unknown> => request.json()).pipe(
      Effect.option,
      Effect.map(Option.getOrUndefined),
    ),
  );

const isSameOriginScriptRequest = (request: Request, url: URL) =>
  request.headers.get("x-mizook-csrf") === "1" && request.headers.get("origin") === url.origin;

type HubRpc = {
  agents(): Promise<AgentInfo[]>;
  createAgent(spec: AgentSpec): Promise<AgentChange>;
  updateAgent(key: string, patch: Partial<AgentSpec>): Promise<AgentChange>;
  deleteAgent(key: string): Promise<AgentChange>;
};

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Creates, changes or deletes an agent, with the same rules as `tools.agents.manage`. */
const manageAgent = async (
  env: Env,
  who: string,
  op: "create" | "update" | "delete",
  slug: string,
  input: unknown,
): Promise<Response> => {
  const hub = env.Hub.getByName("hub") as unknown as HubRpc;
  const body = (Predicate.isObject(input) ? input : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined);
  const toolsGiven = "tools" in body;
  if (toolsGiven && body["tools"] !== null && !isStringList(body["tools"]))
    return json({ error: "bad request" }, 400);
  const tools = toolsGiven ? (body["tools"] as string[] | null) : undefined;
  const model = text("model")?.trim();
  if (model !== undefined && model !== "" && invalidSettingReason("model", model))
    return json({ error: "That is not a model id" }, 400);

  const change =
    op === "create"
      ? await hub.createAgent({
          slug: text("slug") ?? "",
          name: text("name") ?? text("slug") ?? "",
          role: text("role") ?? "",
          persona: text("persona") ?? "",
          ...(tools !== undefined && { tools }),
        })
      : op === "update"
        ? await hub.updateAgent(slug, {
            ...(text("slug") !== undefined && { slug: text("slug")! }),
            ...(text("name") !== undefined && { name: text("name")! }),
            ...(text("role") !== undefined && { role: text("role")! }),
            ...(text("persona") !== undefined && { persona: text("persona")! }),
            ...(tools !== undefined && { tools }),
          })
        : await hub.deleteAgent(slug);
  if (!change.ok) return json({ error: change.error }, 400);
  const agent = change.agent;
  if (op === "delete") return json({ ok: true, said: `Deleted /${agent.slug}.` });
  const rpc = env.AgentObject.getByName(agent.doName) as unknown as ChannelRpc & {
    reload(): Promise<void>;
  };
  if (model !== undefined) await rpc.setting(who, "model", model === "" ? undefined : model);
  if (op === "update") await rpc.reload();
  return json({
    ok: true,
    said: `${op === "create" ? "Created" : "Saved"} /${agent.slug} (${agent.name}).`,
  });
};

const act = async (request: Request, url: URL, who: string, env: Env): Promise<Response> => {
  if (!isSameOriginScriptRequest(request, url)) return json({ error: "forbidden" }, 403);

  if (url.pathname === "/admin/api/agents")
    return manageAgent(env, who, "create", "", await bodyOf(request));
  const agentOp = /^\/admin\/api\/agents\/([a-z][a-z0-9_]{1,31})\/(update|delete)$/.exec(
    url.pathname,
  );
  if (agentOp)
    return manageAgent(
      env,
      who,
      agentOp[2] as "update" | "delete",
      agentOp[1]!,
      await bodyOf(request),
    );

  const hub = env.Hub.getByName("hub") as unknown as { agents(): Promise<AgentInfo[]> };
  const channel = (await hub.agents()).find((a) => a.doName === url.searchParams.get("c"));
  if (!channel) return json({ error: "no such channel" }, 404);
  const rpc = env.AgentObject.getByName(channel.doName) as unknown as ChannelRpc;

  if (url.pathname === "/admin/api/stop") {
    return (await rpc.stop(who)) ? json({ ok: true }) : json({ error: "already gone" }, 409);
  }

  if (url.pathname === "/admin/api/artifacts") {
    const body = (await bodyOf(request)) as
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
    const body = await bodyOf(request);
    if (!Predicate.isObject(body)) return json({ error: "bad request" }, 400);
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
    const body = (await bodyOf(request)) as { value?: unknown } | undefined;
    const value = typeof body?.value === "string" ? body.value.trim() : undefined;
    if (body === undefined || (body.value !== undefined && value === undefined))
      return json({ error: "bad request" }, 400);
    const invalidReason =
      value === undefined || value === "" ? undefined : invalidSettingReason(key, value);
    if (invalidReason) return json({ error: invalidReason }, 400);
    return json({ ok: true, said: await rpc.setting(who, key, value === "" ? undefined : value) });
  }

  const match =
    /^\/admin\/api\/(?:approvals\/(\d+)\/(approve|deny)|schedules\/(\d+)\/(cancel))$/.exec(
      url.pathname,
    );
  const action = match && ACTIONS[(match[2] ?? match[4])!];
  if (!match || !action) return json({ error: "not found" }, 404);
  if (action === "cancel_schedule") {
    const id = Number(match[3]);
    const automation = await automationsOf(env).get(id);
    const agentId = channel.doName.replace(/^agent:/, "");
    const actsForThisAgent =
      !!automation && automation.action.kind !== "webhook" && automation.action.agent === agentId;
    if (!actsForThisAgent) return json({ error: "already gone" }, 409);
    return (await automationsOf(env).cancel(id))
      ? json({ ok: true })
      : json({ error: "already gone" }, 409);
  }
  return (await rpc.act(who, action, Number(match[1] ?? match[3])))
    ? json({ ok: true })
    : json({ error: "already gone" }, 409);
};

export const handleAdmin = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  const accessVerifier = verifierFor(env);
  if (!accessVerifier) return new Response("The dashboard is not configured", { status: 503 });
  const who = await Effect.runPromise(
    accessVerifier
      .verify(request.headers.get("cf-access-jwt-assertion"))
      .pipe(Effect.match({ onSuccess: (email) => email, onFailure: () => undefined })),
  );
  if (who === undefined) return new Response("Forbidden", { status: 403 });

  const url = new URL(request.url);
  if (request.method === "POST") return act(request, url, who, env);
  const apiRoute = /^\/admin\/api\/([a-z]+)$/.exec(url.pathname);
  if (apiRoute) return api(apiRoute[1]!, url, env);
  return serveDashboardApp(request, env);
};
