import { Effect } from "effect";
import type { Env } from "../env.ts";
import type { ChannelInfo } from "../host.ts";
import { makeVerifier, type Verifier } from "./access.ts";

interface ChannelRpc {
  dashboard(page: string, params: Record<string, string>): Promise<unknown>;
  act(who: string, action: string, id: number): Promise<boolean>;
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

const PAGES = new Set(["overview", "messages", "message", "memory", "usage", "schedules"]);

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** What the app may load: itself, its own API, and nothing from anywhere else. */
const SHELL_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const api = async (name: string, url: URL, env: Env): Promise<Response> => {
  const hub = env.Hub.getByName("hub") as unknown as { list(): Promise<ChannelInfo[]> };
  const channels = await hub.list();
  if (name === "channels") return json(channels);
  if (!PAGES.has(name)) return json({ error: "not found" }, 404);
  const wanted = url.searchParams.get("c") ?? "";
  const channel = channels.find((c) => c.doName === wanted);
  if (!channel) return json({ error: "no such channel" }, 404);
  const rpc = env.ChatAgent.getByName(channel.doName) as unknown as ChannelRpc;
  const data = await rpc.dashboard(name, Object.fromEntries(url.searchParams));
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

/**
 * A write. A browser sends a cross-site form post with the person's Access cookie, so besides
 * the token it must carry a header a plain form cannot set, and come from this origin.
 */
const act = async (request: Request, url: URL, who: string, env: Env): Promise<Response> => {
  if (request.headers.get("x-mizook-csrf") !== "1" || request.headers.get("origin") !== url.origin)
    return json({ error: "forbidden" }, 403);
  const match =
    /^\/admin\/api\/(?:approvals\/(\d+)\/(approve|deny)|schedules\/(\d+)\/(cancel))$/.exec(
      url.pathname,
    );
  const action = match && ACTIONS[(match[2] ?? match[4])!];
  if (!match || !action) return json({ error: "not found" }, 404);
  const hub = env.Hub.getByName("hub") as unknown as { list(): Promise<ChannelInfo[]> };
  const channel = (await hub.list()).find((c) => c.doName === url.searchParams.get("c"));
  if (!channel) return json({ error: "no such channel" }, 404);
  const rpc = env.ChatAgent.getByName(channel.doName) as unknown as ChannelRpc;
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
