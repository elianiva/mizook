import {
  CSRF_HEADER,
  CSRF_VALUE,
  NewArtifact,
  paths,
  routes,
  type AgentRow,
  type Channel,
  type Overview,
  type ReadPage,
  type RunRow,
  type ScheduleRow,
  type Summary,
} from "@mizook/admin-api";
import { Effect, Option, Predicate, Schema } from "effect";
import type { Env } from "../env.ts";
import type { AgentInfo } from "../host.ts";
import { KIND_TYPES } from "../artifact-render.ts";
import { agentObject, automationsObject, hubObject } from "../objects.ts";
import { isSettingKey, settingRefusal } from "../state.ts";
import { verifierFor } from "./access.ts";

/** What the Agents page shows: an agent's identity and configuration, not its activity. */
const agentRow = (a: AgentInfo, model: string): AgentRow => ({
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

const PAGES = new Set<string>([
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
] satisfies ReadonlyArray<ReadPage>);

const agentAsChannelRow = (a: AgentInfo): Channel => ({
  doName: a.doName,
  threadId: a.slug,
  name: a.name,
  lastActive: a.lastActive,
});

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const SELF_ONLY_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const agentAutomations = async (
  env: Env,
  agent: AgentInfo,
  page: "schedules" | "runs",
): Promise<ReadonlyArray<ScheduleRow> | ReadonlyArray<RunRow>> => {
  const mine = await automationsObject(env).list(agent.id);
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
  return (await automationsObject(env).runs(50))
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
  const hub = hubObject(env);
  const agents = await hub.agents();
  const channels = agents.map(agentAsChannelRow);
  if (name === "channels") return json(channels);
  if (name === "profile") return json(await hub.profile());
  if (name === "agents")
    return json(
      await Promise.all(
        agents.map(async (a) => {
          const o = await agentObject(env, a.doName).overview();
          return agentRow(a, o.settings["model"] ?? "");
        }),
      ),
    );
  if (name === "summary") {
    const overviewRowPerChannel = await Promise.all(
      channels.map(async (c): Promise<Summary> => {
        const o = await agentObject(env, c.doName).overview();
        return {
          doName: c.doName,
          name: c.name,
          lastActive: c.lastActive,
          messages: o.messages,
          spend24h: o.spend.last24h,
          spend7d: o.spend.last7d,
          pending: o.turns.length,
          approvals: o.approvals.length,
          schedules: (await automationsObject(env).list(c.doName.replace(/^agent:/, ""))).filter(
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
  const rpc = agentObject(env, channel.doName);
  if (name === "overview") {
    const data = await rpc.overview();
    const activeTimedAutomations = (await automationsObject(env).list(agent.id)).filter(
      (a) => a.active && a.spec.kind !== "webhook",
    );
    const reply: Overview = {
      ...data,
      schedules: activeTimedAutomations.length,
      nextSchedule:
        activeTimedAutomations.length === 0
          ? null
          : Math.min(...activeTimedAutomations.map((a) => a.nextAt)),
    };
    return json(reply);
  }
  const data = await rpc.dashboard(name, Object.fromEntries(url.searchParams));
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

const bodyOf = (request: Request): Promise<unknown> =>
  Effect.runPromise(
    Effect.tryPromise(async (): Promise<unknown> => request.json()).pipe(
      Effect.option,
      Effect.map(Option.getOrUndefined),
    ),
  );

const isSameOriginScriptRequest = (request: Request, url: URL) =>
  request.headers.get(CSRF_HEADER) === CSRF_VALUE && request.headers.get("origin") === url.origin;

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
  const hub = hubObject(env);
  const body = (Predicate.isObject(input) ? input : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined);
  const toolsGiven = "tools" in body;
  if (toolsGiven && body["tools"] !== null && !isStringList(body["tools"]))
    return json({ error: "bad request" }, 400);
  const tools = toolsGiven ? (body["tools"] as string[] | null) : undefined;
  const model = text("model")?.trim();
  const badModel = model === undefined || model === "" ? undefined : settingRefusal("model", model);
  if (badModel) return json({ error: badModel }, 400);

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
  const rpc = agentObject(env, agent.doName);
  if (model !== undefined) await rpc.setting(who, "model", model === "" ? undefined : model);
  if (op === "update") await rpc.reload();
  return json({
    ok: true,
    said: `${op === "create" ? "Created" : "Saved"} /${agent.slug} (${agent.name}).`,
  });
};

const act = async (request: Request, url: URL, who: string, env: Env): Promise<Response> => {
  if (!isSameOriginScriptRequest(request, url)) return json({ error: "forbidden" }, 403);

  if (url.pathname === paths.newAgent)
    return manageAgent(env, who, "create", "", await bodyOf(request));
  const agentOp = routes.agent.exec(url.pathname);
  if (agentOp)
    return manageAgent(
      env,
      who,
      agentOp[2] as "update" | "delete",
      agentOp[1]!,
      await bodyOf(request),
    );

  const hub = hubObject(env);
  const channel = (await hub.agents()).find((a) => a.doName === url.searchParams.get("c"));
  if (!channel) return json({ error: "no such channel" }, 404);
  const rpc = agentObject(env, channel.doName);

  if (url.pathname === paths.stop) {
    return (await rpc.stop(who)) ? json({ ok: true }) : json({ error: "already gone" }, 409);
  }

  if (url.pathname === paths.newArtifact) {
    const draft = Schema.decodeUnknownOption(NewArtifact)(await bodyOf(request));
    if (Option.isNone(draft)) return json({ error: "bad request" }, 400);
    const { name, kind, content } = draft.value;
    const made = await rpc.publishArtifact(who, name.trim(), content, KIND_TYPES[kind]);
    return made.ok ? json(made) : json({ error: made.error }, 400);
  }

  const edit = routes.edit.exec(url.pathname);
  if (edit) {
    const body = await bodyOf(request);
    if (!Predicate.isObject(body)) return json({ error: "bad request" }, 400);
    const result = await rpc.edit(who, edit[1]!, body);
    return result.ok ? json(result) : json(result, 400);
  }

  const artifact = routes.artifact.exec(url.pathname);
  if (artifact) {
    return (await rpc.artifact(who, artifact[1]!, artifact[2]!))
      ? json({ ok: true })
      : json({ error: "already gone" }, 409);
  }

  const setting = routes.setting.exec(url.pathname);
  if (setting) {
    const key = setting[1]!;
    if (!isSettingKey(key)) return json({ error: "not found" }, 404);
    const body = (await bodyOf(request)) as { value?: unknown } | undefined;
    const value = typeof body?.value === "string" ? body.value.trim() : undefined;
    if (body === undefined || (body.value !== undefined && value === undefined))
      return json({ error: "bad request" }, 400);
    const invalidReason =
      value === undefined || value === "" ? undefined : settingRefusal(key, value);
    if (invalidReason) return json({ error: invalidReason }, 400);
    return json({ ok: true, said: await rpc.setting(who, key, value === "" ? undefined : value) });
  }

  const match = routes.approvalOrSchedule.exec(url.pathname);
  const action = match && ACTIONS[(match[2] ?? match[4])!];
  if (!match || !action) return json({ error: "not found" }, 404);
  if (action === "cancel_schedule") {
    const id = Number(match[3]);
    const automation = await automationsObject(env).get(id);
    const agentId = channel.doName.replace(/^agent:/, "");
    const actsForThisAgent =
      !!automation && automation.action.kind !== "webhook" && automation.action.agent === agentId;
    if (!actsForThisAgent) return json({ error: "already gone" }, 409);
    return (await automationsObject(env).cancel(id))
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
  const apiRoute = routes.read.exec(url.pathname);
  if (apiRoute) return api(apiRoute[1]!, url, env);
  return serveDashboardApp(request, env);
};
