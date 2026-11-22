import { expect, test, vi } from "vite-plus/test";
import { handleAdmin } from "../src/admin/handler.ts";
import type { Env } from "../src/env.ts";

const TEAM = "me.cloudflareaccess.com";
const AUD = "a";

const b64 = (data: string | ArrayBuffer) =>
  btoa(typeof data === "string" ? data : String.fromCharCode(...new Uint8Array(data)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** One throwaway key for the file: the handler keeps the team keys it first saw. */
const keys = (async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { pair, jwk };
})();

/** A signed-in request: a token from the key, and the team keys served to match. */
const signedIn = async () => {
  const { pair, jwk } = await keys;
  vi.stubGlobal("fetch", async () =>
    Response.json({ keys: [{ kid: "k", kty: "RSA", n: jwk.n, e: jwk.e }] }),
  );
  const body = `${b64(JSON.stringify({ alg: "RS256", kid: "k" }))}.${b64(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: Date.now() / 1000 + 600, email: "me@example.com" }))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(body),
  );
  return `${body}.${b64(sig)}`;
};

const call = (
  env: Partial<Env>,
  path = "/admin",
  init?: RequestInit,
  headers: Record<string, string> = {},
) => handleAdmin(new Request(`https://x.test${path}`, { ...init, headers }), env as Env);

const agent = {
  id: "a1",
  slug: "finance",
  name: "Finance",
  role: "",
  persona: "",
  tools: undefined,
  doName: "agent:a1",
  isDefault: true,
  bound: [],
  created: 0,
  lastActive: 1,
};
const channel = { doName: "agent:a1", threadId: "finance", name: "Finance", lastActive: 1 };
const configured = (extra: Partial<Env> = {}): Partial<Env> => ({
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  Hub: { getByName: () => ({ agents: async () => [agent] }) } as never,
  AgentObject: {
    getByName: () => ({
      dashboard: async (page: string) => (page === "message" ? undefined : { page }),
    }),
  } as never,
  ...extra,
});

test("the dashboard is shut when unconfigured, without a token, or for a write", async () => {
  expect((await call({})).status).toBe(503);
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  expect((await call(env)).status).toBe(403);
  expect((await call(env, "/admin", {}, { "cf-access-jwt-assertion": "x.y.z" })).status).toBe(403);
  expect((await call(env, "/admin", { method: "PUT" })).status).toBe(405);
  expect((await call(env, "/admin/api/approvals/1/approve", { method: "POST" })).status).toBe(403);
  expect((await call(env, "/admin/api/channels")).status).toBe(403);
});

test("a signed-in request reads channels and one channel's pages, and unknown ones are 404", async () => {
  const headers = { "cf-access-jwt-assertion": await signedIn() };
  const env = configured();
  const channels = await call(env, "/admin/api/channels", undefined, headers);
  expect(await channels.json()).toEqual([channel]);
  const page = await call(env, "/admin/api/memory?c=agent%3Aa1", undefined, headers);
  expect(await page.json()).toEqual({ page: "memory" });
  expect((await call(env, "/admin/api/memory?c=other", undefined, headers)).status).toBe(404);
  expect((await call(env, "/admin/api/nothing?c=agent%3Aa1", undefined, headers)).status).toBe(404);
  expect((await call(env, "/admin/api/message?c=agent%3Aa1&i=9", undefined, headers)).status).toBe(
    404,
  );
  vi.unstubAllGlobals();
});

test("a route of the app gets the app's HTML, a file gets itself, both under a strict policy", async () => {
  const headers = { "cf-access-jwt-assertion": await signedIn() };
  const asked: string[] = [];
  const env = configured({
    ASSETS: {
      fetch: async (request: Request) => {
        asked.push(new URL(request.url).pathname);
        return new Response("asset");
      },
    } as never,
  });
  const route = await call(env, "/admin/log/7", undefined, headers);
  const file = await call(env, "/admin/assets/index.js", undefined, headers);
  expect(asked).toEqual(["/admin/", "/admin/assets/index.js"]);
  expect(route.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(file.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect((await call(configured(), "/admin", undefined, headers)).status).toBe(503);
  vi.unstubAllGlobals();
});

test("a write needs the token, the csrf header and this origin, and acts once", async () => {
  const token = await signedIn();
  const calls: unknown[][] = [];
  const env = configured({
    AgentObject: {
      getByName: () => ({
        act: async (...args: unknown[]) => {
          calls.push(args);
          return calls.length === 1;
        },
      }),
    } as never,
  });
  const post = (path: string, headers: Record<string, string>) =>
    call(env, path, { method: "POST" }, { "cf-access-jwt-assertion": token, ...headers });
  const good = { "x-mizook-csrf": "1", origin: "https://x.test" };
  const path = "/admin/api/approvals/7/deny?c=agent%3Aa1";

  expect((await post(path, { origin: "https://x.test" })).status).toBe(403);
  expect((await post(path, { "x-mizook-csrf": "1", origin: "https://evil.test" })).status).toBe(
    403,
  );
  expect(calls).toEqual([]);

  expect((await post(path, good)).status).toBe(200);
  expect(calls).toEqual([["me@example.com", "deny", 7]]);
  expect((await post(path, good)).status).toBe(409);
  expect((await post("/admin/api/schedules/3/cancel?c=agent%3Aa1", good)).status).toBe(409);
  expect(calls.at(-1)).toEqual(["me@example.com", "cancel_schedule", 3]);
  expect((await post("/admin/api/schedules/3/approve?c=agent%3Aa1", good)).status).toBe(404);
  expect((await post("/admin/api/approvals/7/deny?c=nope", good)).status).toBe(404);
  vi.unstubAllGlobals();
});

test("stop and settings are writes too, and settings are checked before they reach the channel", async () => {
  const token = await signedIn();
  const calls: unknown[][] = [];
  const env = configured({
    AgentObject: {
      getByName: () => ({
        stop: async (...args: unknown[]) => (calls.push(["stop", ...args]), true),
        setting: async (...args: unknown[]) => (calls.push(["setting", ...args]), "saved"),
      }),
    } as never,
  });
  const post = (path: string, body?: unknown) =>
    call(
      env,
      path,
      { method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) },
      { "cf-access-jwt-assertion": token, "x-mizook-csrf": "1", origin: "https://x.test" },
    );
  const c = "?c=agent%3Aa1";

  expect((await post(`/admin/api/stop${c}`)).status).toBe(200);
  expect((await post(`/admin/api/settings/budget${c}`, { value: "2.5" })).status).toBe(200);
  expect((await post(`/admin/api/settings/budget${c}`, { value: "" })).status).toBe(200);
  expect((await post(`/admin/api/settings/budget${c}`, { value: "lots" })).status).toBe(400);
  expect((await post(`/admin/api/settings/budget${c}`, { value: "-1" })).status).toBe(400);
  expect((await post(`/admin/api/settings/timezone${c}`, { value: "Mars/Base" })).status).toBe(400);
  expect((await post(`/admin/api/settings/model${c}`, { value: "a b; rm" })).status).toBe(400);
  expect((await post(`/admin/api/settings/model${c}`, { value: 5 })).status).toBe(400);
  expect((await post(`/admin/api/settings/secret${c}`, { value: "x" })).status).toBe(404);
  expect((await post(`/admin/api/settings/budget${c}`)).status).toBe(400);
  expect(calls).toEqual([
    ["stop", "me@example.com"],
    ["setting", "me@example.com", "budget", "2.5"],
    ["setting", "me@example.com", "budget", undefined],
  ]);
  vi.unstubAllGlobals();
});

test("agent edits go through the channel, and a bad body or refusal is a 400", async () => {
  const token = await signedIn();
  const calls: unknown[][] = [];
  const env = configured({
    AgentObject: {
      getByName: () => ({
        edit: async (...args: unknown[]) => {
          calls.push(args);
          return args[2] !== null && typeof args[2] === "object" && "fail" in args[2]
            ? { ok: false, error: "Nope" }
            : { ok: true, said: "Saved." };
        },
      }),
    } as never,
  });
  const post = (body?: unknown) =>
    call(
      env,
      "/admin/api/skills?c=agent%3Aa1",
      {
        method: "POST",
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      },
      { "cf-access-jwt-assertion": token, "x-mizook-csrf": "1", origin: "https://x.test" },
    );

  expect((await post()).status).toBe(400);
  expect((await post([])).status).toBe(400);
  expect(calls).toEqual([]);

  const saved = await post({ action: "save", name: "weekly-review" });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ ok: true, said: "Saved." });
  expect(calls).toEqual([["me@example.com", "skills", { action: "save", name: "weekly-review" }]]);

  const refused = await post({ fail: true });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ ok: false, error: "Nope" });
  vi.unstubAllGlobals();
});

test("the summary has one line per agent", async () => {
  const headers = { "cf-access-jwt-assertion": await signedIn() };
  const env = configured({
    AgentObject: {
      getByName: () => ({
        dashboard: async () => ({
          messages: 4,
          spend: { last24h: 0.5, last7d: 2 },
          turns: [{}],
          approvals: [{}, {}],
          schedules: 3,
          settings: { budget: "1" },
        }),
      }),
    } as never,
  });
  const res = await call(env, "/admin/api/summary", undefined, headers);
  expect(await res.json()).toEqual([
    {
      doName: "agent:a1",
      name: "Finance",
      lastActive: 1,
      messages: 4,
      spend24h: 0.5,
      spend7d: 2,
      pending: 1,
      approvals: 2,
      schedules: 3,
      budget: 1,
    },
  ]);
  vi.unstubAllGlobals();
});
