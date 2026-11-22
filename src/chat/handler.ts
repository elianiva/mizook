import { accessWho, verifierFor } from "../admin/access.ts";
import type { Env } from "../env.ts";
import type { AgentInfo, WebThreadInfo } from "../host.ts";
import type { WebState, WebTurnResult } from "./types.ts";

interface HubChatApi {
  agents(): Promise<AgentInfo[]>;
  webThreads(): Promise<WebThreadInfo[]>;
  webThread(id: string): Promise<WebThreadInfo | undefined>;
  createWebThread(agentKey: string | undefined): Promise<WebThreadInfo | undefined>;
  renameWebThread(id: string, title: string): Promise<WebThreadInfo | undefined>;
  archiveWebThread(id: string): Promise<boolean>;
  webDefaultAgent(): Promise<AgentInfo>;
}

interface AgentChatApi {
  webTurn(place: string, text: string, requestId: string): Promise<WebTurnResult>;
  webState(place: string, after: number): Promise<WebState>;
  webStop(place: string): Promise<boolean>;
  act(who: string, action: string, id: number): Promise<boolean>;
}

const MAX_TEXT_CHARS = 20_000;
const MAX_REQUEST_ID_CHARS = 120;
const NO_STORE = { "cache-control": "no-store" } as const;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

const badRequest = (error: string) => json({ error }, 400);

const threadView = (thread: WebThreadInfo) => ({
  id: thread.id,
  title: thread.title,
  preview: thread.preview,
  created: thread.created,
  updated: thread.updated,
  agent: { slug: thread.agent.slug, name: thread.agent.name },
});

const agentView = (agent: AgentInfo, webDefault: AgentInfo) => ({
  id: agent.id,
  slug: agent.slug,
  name: agent.name,
  isDefault: agent.isDefault,
  isWebDefault: agent.id === webDefault.id,
});

const bodyOf = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const stringField = (body: Record<string, unknown>, key: string): string | undefined =>
  typeof body[key] === "string" ? body[key] : undefined;

const afterOf = (url: URL): number => {
  const raw = Number(url.searchParams.get("after") ?? "0");
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
};

const isWrite = (method: string) => method === "POST" || method === "PATCH";

const sameOriginScriptRequest = (request: Request, url: URL) =>
  request.headers.get("x-mizook-csrf") === "1" && request.headers.get("origin") === url.origin;

/** The chat API: threads in the Hub, turns and transcripts in each agent. */
export const handleChat = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "GET" && !isWrite(request.method)) {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!verifierFor(env, env.CHAT_ACCESS_AUD))
    return new Response("The chat is not configured", { status: 503 });

  const who = await accessWho(request, env, env.CHAT_ACCESS_AUD);
  if (who === undefined) return new Response("Forbidden", { status: 403 });

  const url = new URL(request.url);
  if (isWrite(request.method) && !sameOriginScriptRequest(request, url))
    return json({ error: "forbidden" }, 403);

  const parts = url.pathname.split("/").filter((part) => part !== "");
  if (parts[0] !== "c" || parts[1] !== "api") return json({ error: "not found" }, 404);
  const rest = parts.slice(2);

  const hub = env.Hub.getByName("hub") as unknown as HubChatApi;
  const agentOf = (doName: string) => env.AgentObject.getByName(doName) as unknown as AgentChatApi;

  try {
    if (request.method === "GET" && rest.length === 1 && rest[0] === "bootstrap") {
      const [agents, threads, webDefault] = await Promise.all([
        hub.agents(),
        hub.webThreads(),
        hub.webDefaultAgent(),
      ]);
      return json({
        agents: agents.map((agent) => agentView(agent, webDefault)),
        threads: threads.map(threadView),
        defaultAgent: { slug: webDefault.slug, name: webDefault.name },
      });
    }

    if (request.method === "GET" && rest.length === 1 && rest[0] === "threads")
      return json((await hub.webThreads()).map(threadView));

    if (request.method === "POST" && rest.length === 1 && rest[0] === "threads") {
      const body = await bodyOf(request);
      if (body === undefined) return badRequest("bad request");
      const agentKey = stringField(body, "agent");
      const thread = await hub.createWebThread(agentKey);
      return thread === undefined
        ? badRequest("No agent called that.")
        : json({ thread: threadView(thread) }, 201);
    }

    if (rest[0] !== "threads" || rest[1] === undefined || rest[1] === "") {
      if (rest[0] === "approvals" && rest[1] !== undefined && request.method === "POST") {
        const body = await bodyOf(request);
        const action = body === undefined ? undefined : stringField(body, "action");
        if (action !== "approve" && action !== "always" && action !== "deny")
          return badRequest("Pick approve, always or deny.");
        const threadId = stringField(body ?? {}, "thread");
        if (threadId === undefined) return badRequest("bad request");
        const thread = await hub.webThread(threadId);
        if (thread === undefined) return json({ error: "not found" }, 404);
        const acted = await agentOf(thread.agent.doName).act(who, action, Number(rest[1]));
        return acted ? json({ ok: true }) : json({ error: "already handled" }, 409);
      }
      return json({ error: "not found" }, 404);
    }

    const threadId = rest[1];
    const thread = await hub.webThread(threadId);
    if (thread === undefined) return json({ error: "not found" }, 404);
    const place = `web:${thread.id}`;
    const agent = agentOf(thread.agent.doName);

    if (request.method === "GET" && rest.length === 2) {
      const state = await agent.webState(place, afterOf(url));
      return json({ thread: threadView(thread), ...state });
    }

    if (request.method === "PATCH" && rest.length === 2) {
      const body = await bodyOf(request);
      const title = body === undefined ? undefined : stringField(body, "title");
      if (title === undefined) return badRequest("Give the chat a name.");
      const renamed = await hub.renameWebThread(threadId, title);
      return renamed === undefined
        ? badRequest("Give the chat a name.")
        : json({ thread: threadView(renamed) });
    }

    if (request.method === "POST" && rest.length === 3 && rest[2] === "messages") {
      const body = await bodyOf(request);
      const text = body === undefined ? undefined : stringField(body, "text")?.trim();
      if (text === undefined || text === "") return badRequest("Say something first.");
      if (text.length > MAX_TEXT_CHARS) return badRequest("That message is too long.");
      const asked = body === undefined ? undefined : stringField(body, "requestId");
      const requestId =
        asked !== undefined && asked !== ""
          ? asked.slice(0, MAX_REQUEST_ID_CHARS)
          : crypto.randomUUID();
      const result = await agent.webTurn(place, text, requestId);
      if (!result.ok) return json({ error: result.reason }, 409);
      const updated = (await hub.webThread(threadId)) ?? thread;
      return json({ ...result, thread: threadView(updated) });
    }

    if (request.method === "POST" && rest.length === 3 && rest[2] === "stop") {
      const stopped = await agent.webStop(place);
      return json({ ok: stopped });
    }

    if (request.method === "POST" && rest.length === 3 && rest[2] === "archive") {
      const archived = await hub.archiveWebThread(threadId);
      return archived ? json({ ok: true }) : json({ error: "not found" }, 404);
    }

    return json({ error: "not found" }, 404);
  } catch (cause) {
    console.error("chat request failed", cause);
    return json({ error: "Something went wrong on my side." }, 500);
  }
};
