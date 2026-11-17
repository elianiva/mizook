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

const channel = { doName: "-100:1", threadId: "t", name: "finance", lastActive: 1 };
const configured = (extra: Partial<Env> = {}): Partial<Env> => ({
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  Hub: { getByName: () => ({ list: async () => [channel] }) } as never,
  ChatAgent: {
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
  expect((await call(env, "/admin", { method: "POST" })).status).toBe(405);
  expect((await call(env, "/admin/api/channels")).status).toBe(403);
});

test("a signed-in request reads channels and one channel's pages, and unknown ones are 404", async () => {
  const headers = { "cf-access-jwt-assertion": await signedIn() };
  const env = configured();
  const channels = await call(env, "/admin/api/channels", undefined, headers);
  expect(await channels.json()).toEqual([channel]);
  const page = await call(env, "/admin/api/memory?c=-100%3A1", undefined, headers);
  expect(await page.json()).toEqual({ page: "memory" });
  expect((await call(env, "/admin/api/memory?c=other", undefined, headers)).status).toBe(404);
  expect((await call(env, "/admin/api/nothing?c=-100%3A1", undefined, headers)).status).toBe(404);
  expect((await call(env, "/admin/api/message?c=-100%3A1&i=9", undefined, headers)).status).toBe(
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
