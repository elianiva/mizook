import { expect, test } from "vite-plus/test";
import { handleAdmin } from "../src/admin/handler.ts";
import type { Env } from "../src/env.ts";

const call = (env: Partial<Env>, init?: RequestInit, headers: Record<string, string> = {}) =>
  handleAdmin(new Request("https://x.test/admin", { ...init, headers }), env as Env);

test("the dashboard is shut when unconfigured, without a token, or for a write", async () => {
  expect((await call({})).status).toBe(503);
  const env = { ACCESS_TEAM_DOMAIN: "me.cloudflareaccess.com", ACCESS_AUD: "a" };
  expect((await call(env)).status).toBe(403);
  expect((await call(env, {}, { "cf-access-jwt-assertion": "x.y.z" })).status).toBe(403);
  expect((await call(env, { method: "POST" })).status).toBe(405);
});
