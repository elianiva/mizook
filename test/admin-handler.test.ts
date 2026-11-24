import { Reads, type ReadPage } from "@mizook/admin-api";
import { Arbitrary, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, vi } from "vite-plus/test";
import { handleAdmin } from "../src/admin/handler.ts";
import { overview } from "../src/admin/read.ts";
import type { Env } from "../src/env.ts";
import { property } from "./property.ts";

const TEAM = "me.cloudflareaccess.com";
const AUD = "a";
const ORIGIN = "https://x.test";
const EMAIL = "me@example.com";

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

const oneOf = <const A extends ReadonlyArray<unknown>>(values: A): Arbitrary.Arbitrary<A[number]> =>
  Arbitrary.map(int(0, values.length - 1), (k) => values[k]);

const text = Arbitrary.map(Arbitrary.schema(Schema.String), (s) => s.replace(/\p{Cs}/gu, "?"));

const pattern = (regex: RegExp) => Arbitrary.schema(Schema.String.check(Schema.isPattern(regex)));

const b64 = (data: string | ArrayBuffer) =>
  btoa(
    Array.from(
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data),
      (b) => String.fromCharCode(b),
    ).join(""),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const rsa = async () => {
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
};

const team = await rsa();
const stranger = await rsa();

const sign = async (key: CryptoKey, claims: Record<string, unknown>) => {
  const body = `${b64(JSON.stringify({ alg: "RS256", kid: "k" }))}.${b64(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
  return `${body}.${b64(sig)}`;
};

const claims = { iss: `https://${TEAM}`, aud: [AUD], exp: Date.now() / 1000 + 3600, email: EMAIL };
const token = await sign(team.pair.privateKey, claims);
const badTokens = [
  undefined,
  "",
  "x.y.z",
  "not-a-token",
  await sign(stranger.pair.privateKey, claims),
  await sign(team.pair.privateKey, { ...claims, exp: Date.now() / 1000 - 1 }),
  await sign(team.pair.privateKey, { ...claims, aud: ["other"] }),
  await sign(team.pair.privateKey, { ...claims, iss: "https://evil.example" }),
] as const;

beforeEach(() => {
  vi.stubGlobal("fetch", async () =>
    Response.json({ keys: [{ kid: "k", kty: "RSA", n: team.jwk.n, e: team.jwk.e }] }),
  );
  return () => vi.unstubAllGlobals();
});

const call = (
  env: Partial<Env>,
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
) => handleAdmin(new Request(`${ORIGIN}${path}`, { ...init, headers }), env as Env);

const signedIn = { "cf-access-jwt-assertion": token };
const writer = { ...signedIn, "x-mizook-csrf": "1", origin: ORIGIN };

const post = (env: Partial<Env>, path: string, body?: string) =>
  call(env, path, { method: "POST", ...(body !== undefined && { body }) }, writer);

type Agent = { id: string; slug: string; name: string; lastActive: number };
type Automation = { id: number; agent: string; active: boolean; nextAt: number };

const agentInfo = (a: Agent) => ({
  ...a,
  role: "",
  persona: "",
  tools: undefined,
  doName: `agent:${a.id}`,
  isDefault: false,
  bound: [],
  created: 0,
});

const agents = Arbitrary.map(
  Arbitrary.array(
    Arbitrary.all({
      id: pattern(/^[a-z0-9]{1,6}$/),
      slug: pattern(/^[a-z][a-z0-9-]{0,8}$/),
      name: text,
      lastActive: int(0, 2_000_000_000_000),
    }),
    { minLength: 1, maxLength: 4 },
  ),
  (list) => [...new Map(list.map((a) => [a.id, a])).values()],
);

const automationsFor = (ids: ReadonlyArray<string>) =>
  Arbitrary.map(
    Arbitrary.array(
      Arbitrary.all({
        agent: oneOf([...ids, "someone-else"]),
        active: oneOf([true, false]),
        nextAt: int(0, 2_000_000_000_000),
      }),
      { maxLength: 6 },
    ),
    (list): Automation[] => list.map((a, k) => ({ ...a, id: k + 1 })),
  );

const world = (
  list: ReadonlyArray<Agent>,
  automations: ReadonlyArray<Automation> = [],
  agentObject: (doName: string) => object = () => ({}),
  cancels: { result: boolean; seen: number[] } = { result: true, seen: [] },
): Partial<Env> => {
  const full = automations.map((a) => ({
    id: a.id,
    spec: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" },
    action: { kind: "turn", agent: a.agent, place: "", prompt: `p${a.id}` },
    nextAt: a.nextAt,
    active: a.active,
    lastHash: undefined,
  }));
  return {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    Hub: { getByName: () => ({ agents: async () => list.map(agentInfo) }) } as never,
    Automations: {
      getByName: () => ({
        list: async (agentId?: string) =>
          full.filter((a) => agentId === undefined || a.action.agent === agentId),
        get: async (id: number) => full.find((a) => a.id === id),
        cancel: async (id: number) => (cancels.seen.push(id), cancels.result),
        runs: async () => [],
      }),
    } as never,
    AgentObject: { getByName: agentObject } as never,
  };
};

const METHODS = ["PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"] as const;
const PATHS = [
  "/admin",
  "/admin/",
  "/admin/log/7",
  "/admin/assets/index.js",
  "/admin/api/channels",
  "/admin/api/summary",
  "/admin/api/memory?c=agent%3Aa1",
  "/admin/api/approvals/1/approve?c=agent%3Aa1",
  "/admin/api/settings/budget?c=agent%3Aa1",
  "/admin/api/stop?c=agent%3Aa1",
] as const;

property(
  "the dashboard refuses other methods, is shut until both Access settings exist, and never touches a channel before that",
  Arbitrary.all({
    method: oneOf([...METHODS, "GET", "POST"]),
    path: oneOf(PATHS),
    team: oneOf([undefined, "", TEAM]),
    aud: oneOf([undefined, "", AUD]),
  }).pipe(
    Arbitrary.filter(
      ({ method, team, aud }) => (method !== "GET" && method !== "POST") || !team || !aud,
    ),
  ),
  async ({ method, path, team, aud }) => {
    const touched: string[] = [];
    const env = {
      ...world([{ id: "a1", slug: "a", name: "A", lastActive: 0 }], [], (doName) => {
        touched.push(doName);
        return {};
      }),
      ACCESS_TEAM_DOMAIN: team,
      ACCESS_AUD: aud,
    };
    const res = await call(env, path, { method }, writer);
    expect(res.status).toBe(method !== "GET" && method !== "POST" ? 405 : 503);
    expect(touched).toEqual([]);
  },
  { runs: 60 },
);

property(
  "without a token Access signed for this team and audience, every read and write is forbidden and reaches no channel",
  Arbitrary.all({
    method: oneOf(["GET", "POST"]),
    path: oneOf(PATHS),
    bad: oneOf(badTokens),
  }),
  async ({ method, path, bad }) => {
    const touched: string[] = [];
    const env = world([{ id: "a1", slug: "a", name: "A", lastActive: 0 }], [], (doName) => {
      touched.push(doName);
      return {};
    });
    const headers: Record<string, string> = { "x-mizook-csrf": "1", origin: ORIGIN };
    if (bad !== undefined) headers["cf-access-jwt-assertion"] = bad;
    const res = await call(env, path, { method }, headers);
    expect(res.status).toBe(403);
    expect(touched).toEqual([]);
  },
  { runs: 40 },
);

property(
  "a signed-in reader gets one channel row per agent, in the hub's order",
  agents,
  async (list) => {
    const res = await call(world(list), "/admin/api/channels", {}, signedIn);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(
      list.map((a) => ({
        doName: `agent:${a.id}`,
        threadId: a.slug,
        name: a.name,
        lastActive: a.lastActive,
      })),
    );
  },
  { runs: 30 },
);

const READ_PAGES = [
  "messages",
  "message",
  "memory",
  "usage",
  "skills",
  "intents",
  "policies",
  "audit",
  "artifacts",
  "artifact",
] as const;
const ALL_PAGES = [
  ...READ_PAGES,
  "overview",
  "schedules",
  "runs",
  "channels",
  "profile",
  "summary",
];

property(
  "a page is read from the chosen channel with the query passed through, and an unknown page, unknown channel or missing data is 404",
  Arbitrary.flatMap(agents, (list) =>
    Arbitrary.all({
      list: Arbitrary.Constant(list),
      page: Arbitrary.flatMap(int(0, 3), (k) =>
        k === 0
          ? pattern(/^[a-z]{1,10}$/).pipe(Arbitrary.filter((p) => !ALL_PAGES.includes(p)))
          : oneOf(READ_PAGES),
      ),
      channel: Arbitrary.flatMap(int(0, 3), (k) =>
        k === 0
          ? oneOf(["", "agent:", "nope", "agent:zzzzzzz"])
          : Arbitrary.map(oneOf(list), (a) => `agent:${a.id}`),
      ),
      extra: Arbitrary.all({ i: pattern(/^[0-9]{1,4}$/), q: text }),
      missing: oneOf([false, false, true]),
    }),
  ),
  async ({ list, page, channel, extra, missing }) => {
    const asked: Array<[string, string, Record<string, string>]> = [];
    const env = world(list, [], (doName) => ({
      dashboard: async (name: string, params: Record<string, string>) => {
        asked.push([doName, name, params]);
        return missing ? undefined : { name, from: doName };
      },
    }));
    const query = new URLSearchParams({ c: channel, ...extra });
    const res = await call(env, `/admin/api/${page}?${query.toString()}`, {}, signedIn);
    const known = (READ_PAGES as ReadonlyArray<string>).includes(page);
    const exists = list.some((a) => `agent:${a.id}` === channel);
    if (!known || !exists) {
      expect(res.status).toBe(404);
      expect(asked).toEqual([]);
      return;
    }
    expect(asked).toEqual([[channel, page, { c: channel, ...extra }]]);
    expect(res.status).toBe(missing ? 404 : 200);
    if (!missing) expect(await res.json()).toEqual({ name: page, from: channel });
  },
  { runs: 60 },
);

property(
  "the schedules page lists only this agent's active automations",
  Arbitrary.flatMap(agents, (list) =>
    Arbitrary.all({
      list: Arbitrary.Constant(list),
      chosen: oneOf(list),
      automations: automationsFor(list.map((a) => a.id)),
    }),
  ),
  async ({ list, chosen, automations }) => {
    const res = await call(
      world(list, automations),
      `/admin/api/schedules?c=agent%3A${chosen.id}`,
      {},
      signedIn,
    );
    expect(await res.json()).toEqual(
      automations
        .filter((a) => a.agent === chosen.id && a.active)
        .map((a) => ({
          id: a.id,
          spec: JSON.stringify({ kind: "cron", expr: "0 9 * * *", timezone: "UTC" }),
          prompt: `p${a.id}`,
          nextAt: a.nextAt,
        })),
    );
  },
  { runs: 30 },
);

property(
  "a route of the app gets the app's HTML uncached, a file gets itself, both under a self-only policy, and nothing is served unbuilt",
  Arbitrary.all({
    segments: Arbitrary.array(pattern(/^[a-z0-9-]{1,8}$/), { maxLength: 3 }).pipe(
      Arbitrary.filter((s) => s[0] !== "api"),
    ),
    extension: oneOf([undefined, "js", "css", "png", "woff2", "SVG"]),
    built: oneOf([true, true, false]),
  }),
  async ({ segments, extension, built }) => {
    const path = `/admin/${segments.join("/")}${extension === undefined || segments.length === 0 ? "" : `.${extension}`}`;
    const isFile = extension !== undefined && segments.length > 0;
    const asked: string[] = [];
    const env = {
      ...world([]),
      ...(built && {
        ASSETS: {
          fetch: async (request: Request) => {
            asked.push(new URL(request.url).pathname);
            return new Response("asset");
          },
        } as never,
      }),
    };
    const res = await call(env, path, {}, signedIn);
    if (!built) {
      expect(res.status).toBe(503);
      return;
    }
    expect(asked).toEqual([isFile ? path : "/admin/"]);
    expect(await res.text()).toBe("asset");
    const policy = res.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe(isFile ? null : "no-store");
  },
  { runs: 40 },
);

property(
  "an approval acts once for the signed-in user only with the csrf header from this origin on a known channel",
  Arbitrary.flatMap(agents, (list) =>
    Arbitrary.all({
      list: Arbitrary.Constant(list),
      channel: Arbitrary.flatMap(int(0, 4), (k) =>
        k === 0 ? Arbitrary.Constant("nope") : Arbitrary.map(oneOf(list), (a) => `agent:${a.id}`),
      ),
      id: int(0, 1_000_000),
      action: oneOf(["approve", "deny"]),
      csrf: oneOf([undefined, "1", "1", "0", "true"]),
      origin: oneOf([undefined, ORIGIN, ORIGIN, "https://evil.test", "http://x.test"]),
      acted: oneOf([true, false]),
    }),
  ),
  async ({ list, channel, id, action, csrf, origin, acted }) => {
    const calls: unknown[][] = [];
    const env = world(list, [], (doName) => ({
      act: async (...args: unknown[]) => (calls.push([doName, ...args]), acted),
    }));
    const headers: Record<string, string> = { ...signedIn };
    if (csrf !== undefined) headers["x-mizook-csrf"] = csrf;
    if (origin !== undefined) headers["origin"] = origin;
    const res = await call(
      env,
      `/admin/api/approvals/${id}/${action}?c=${encodeURIComponent(channel)}`,
      { method: "POST" },
      headers,
    );
    const sameOrigin = csrf === "1" && origin === ORIGIN;
    const known = list.some((a) => `agent:${a.id}` === channel);
    if (!sameOrigin || !known) {
      expect(res.status).toBe(sameOrigin ? 404 : 403);
      expect(calls).toEqual([]);
      return;
    }
    expect(calls).toEqual([[channel, EMAIL, action, id]]);
    expect(res.status).toBe(acted ? 200 : 409);
  },
  { runs: 60 },
);

property(
  "an automation is cancelled only from the page of the agent it acts for, and unknown write routes are 404",
  Arbitrary.flatMap(agents, (list) =>
    Arbitrary.all({
      list: Arbitrary.Constant(list),
      chosen: oneOf(list),
      automations: automationsFor(list.map((a) => a.id)),
      target: int(1, 8),
      result: oneOf([true, true, false]),
      unknown: oneOf([
        undefined,
        undefined,
        "/admin/api/schedules/3/approve",
        "/admin/api/approvals/x/deny",
        "/admin/api/approvals/1/cancel",
        "/admin/api/nothing",
        "/admin/api/settings/Budget",
      ]),
    }),
  ),
  async ({ list, chosen, automations, target, result, unknown }) => {
    const cancels = { result, seen: [] as number[] };
    const acted: unknown[] = [];
    const env = world(
      list,
      automations,
      () => ({ act: async (...args: unknown[]) => (acted.push(args), true) }),
      cancels,
    );
    const c = `?c=agent%3A${chosen.id}`;
    if (unknown !== undefined) {
      expect((await post(env, `${unknown}${c}`)).status).toBe(404);
      expect(cancels.seen).toEqual([]);
      expect(acted).toEqual([]);
      return;
    }
    const res = await post(env, `/admin/api/schedules/${target}/cancel${c}`);
    const mine = automations.some((a) => a.id === target && a.agent === chosen.id);
    expect(cancels.seen).toEqual(mine ? [target] : []);
    expect(res.status).toBe(mine && result ? 200 : 409);
    expect(acted).toEqual([]);
  },
  { runs: 60 },
);

property(
  "stop goes to the chosen channel for the signed-in user and is a conflict when nothing was running",
  Arbitrary.flatMap(agents, (list) =>
    Arbitrary.all({
      list: Arbitrary.Constant(list),
      chosen: oneOf(list),
      stopped: oneOf([true, false]),
    }),
  ),
  async ({ list, chosen, stopped }) => {
    const calls: unknown[][] = [];
    const env = world(list, [], (doName) => ({
      stop: async (who: string) => (calls.push([doName, who]), stopped),
    }));
    const res = await post(env, `/admin/api/stop?c=agent%3A${chosen.id}`);
    expect(calls).toEqual([[`agent:${chosen.id}`, EMAIL]]);
    expect(res.status).toBe(stopped ? 200 : 409);
  },
  { runs: 20 },
);

type SettingCase = {
  key: string;
  body: string | undefined;
  saved?: string | undefined;
  status: number;
};

const space = oneOf(["", " ", "  ", "\t"]);
const spaced = (value: Arbitrary.Arbitrary<string>) =>
  Arbitrary.map(Arbitrary.all([space, value, space]), ([a, v, b]) => ({
    raw: `${a}${v}${b}`,
    value: v,
  }));

const valid = (key: string, value: Arbitrary.Arbitrary<string>): Arbitrary.Arbitrary<SettingCase> =>
  Arbitrary.map(spaced(value), ({ raw, value }) => ({
    key,
    body: JSON.stringify({ value: raw }),
    saved: value,
    status: 200,
  }));

const invalid = (
  key: string,
  value: Arbitrary.Arbitrary<string>,
): Arbitrary.Arbitrary<SettingCase> =>
  Arbitrary.map(spaced(value), ({ raw }) => ({
    key,
    body: JSON.stringify({ value: raw }),
    status: 400,
  }));

const KEYS = ["model", "instructions", "timezone", "budget"] as const;

const settingCase: Arbitrary.Arbitrary<SettingCase> = Arbitrary.flatMap(int(0, 12), (k) => {
  switch (k) {
    case 0:
      return valid(
        "budget",
        Arbitrary.flatMap(int(0, 1), (d) =>
          d === 0
            ? Arbitrary.map(int(0, 100_000), String)
            : Arbitrary.map(int(0, 100_000), (n) => (n / 100).toFixed(2)),
        ),
      );
    case 1:
      return invalid(
        "budget",
        Arbitrary.flatMap(int(0, 1), (d) =>
          d === 0
            ? oneOf(["lots", "Infinity", "NaN", "1/2", "$5", "1,5"])
            : Arbitrary.map(int(1, 100_000), (n) => `-${n / 100}`),
        ),
      );
    case 2:
      return valid("timezone", oneOf(["Asia/Jakarta", "UTC", "Europe/Berlin", "America/New_York"]));
    case 3:
      return invalid("timezone", oneOf(["Mars/Base", "Asia/Nowhere", "Not a zone", "Europe/"]));
    case 4:
      return valid("model", pattern(/^[\w.:/-]{1,120}$/));
    case 5:
      return invalid(
        "model",
        Arbitrary.flatMap(int(0, 1), (d) =>
          d === 0
            ? Arbitrary.map(pattern(/^[\w]{1,10}[ ;$'"é][\w]{1,10}$/), (s) => s)
            : Arbitrary.Constant("m".repeat(121)),
        ),
      );
    case 6:
      return valid(
        "instructions",
        Arbitrary.flatMap(int(0, 1), (d) =>
          d === 0 ? Arbitrary.map(text, (s) => `i${s}i`) : Arbitrary.Constant("i".repeat(4000)),
        ),
      );
    case 7:
      return Arbitrary.map(oneOf(KEYS), (key) => ({
        key,
        body: JSON.stringify({
          value: key === "instructions" ? "i".repeat(4001) : "9".repeat(4001),
        }),
        status: 400,
      }));
    case 8:
      return Arbitrary.map(
        Arbitrary.all({ key: oneOf(KEYS), blank: space, form: oneOf(["blank", "absent"]) }),
        ({ key, blank, form }) => ({
          key,
          body: form === "blank" ? JSON.stringify({ value: blank }) : "{}",
          saved: undefined,
          status: 200,
        }),
      );
    case 9:
      return Arbitrary.map(
        Arbitrary.all({
          key: oneOf(KEYS),
          body: oneOf([
            undefined,
            "not json",
            '{"value":5}',
            '{"value":null}',
            '{"value":true}',
            '{"value":["x"]}',
          ]),
        }),
        ({ key, body }) => ({ key, body, status: 400 }),
      );
    default:
      return Arbitrary.map(
        pattern(/^[a-z]{1,10}$/).pipe(
          Arbitrary.filter((key) => !(KEYS as ReadonlyArray<string>).includes(key)),
        ),
        (key) => ({ key, body: JSON.stringify({ value: "x" }), status: 404 }),
      );
  }
});

property(
  "a setting reaches the channel trimmed, blank as cleared, only when its value is valid for its key",
  settingCase,
  async (c) => {
    const calls: unknown[][] = [];
    const env = world([{ id: "a1", slug: "a", name: "A", lastActive: 0 }], [], () => ({
      setting: async (...args: unknown[]) => (calls.push(args), "saved"),
    }));
    const res = await post(env, `/admin/api/settings/${c.key}?c=agent%3Aa1`, c.body);
    expect(res.status).toBe(c.status);
    expect(calls).toEqual(c.status === 200 ? [[EMAIL, c.key, c.saved]] : []);
  },
);

property(
  "an edit with an object body goes to the channel and its refusal is a 400, and any other body never reaches it",
  Arbitrary.all({
    kind: oneOf(["profile", "skills", "intents", "policies"]),
    body: Arbitrary.flatMap(int(0, 2), (k) =>
      k === 0
        ? oneOf([undefined, "[]", "null", "7", '"text"', "not json", "{"])
        : Arbitrary.map(
            Arbitrary.all({
              action: oneOf(["save", "delete", "cancel"]),
              name: text,
              fail: oneOf([true, false]),
            }),
            (o) => JSON.stringify(o),
          ),
    ),
  }),
  async ({ kind, body }) => {
    const calls: unknown[][] = [];
    const env = world([{ id: "a1", slug: "a", name: "A", lastActive: 0 }], [], () => ({
      edit: async (...args: unknown[]) => {
        calls.push(args);
        return (args[2] as { fail: boolean }).fail
          ? { ok: false, error: "Nope" }
          : { ok: true, said: "Saved." };
      },
    }));
    const res = await post(env, `/admin/api/${kind}?c=agent%3Aa1`, body);
    const parsed = body?.startsWith('{"') ? (JSON.parse(body) as { fail: boolean }) : undefined;
    if (parsed === undefined) {
      expect(res.status).toBe(400);
      expect(calls).toEqual([]);
      return;
    }
    const failed = parsed.fail;
    expect(calls).toEqual([[EMAIL, kind, parsed]]);
    expect(res.status).toBe(failed ? 400 : 200);
    expect(await res.json()).toEqual(
      failed ? { ok: false, error: "Nope" } : { ok: true, said: "Saved." },
    );
  },
  { runs: 60 },
);

const BUDGETS = [
  [undefined, 0],
  ["1", 1],
  ["2.5", 2.5],
  ["", 0],
  ["lots", 0],
  ["0", 0],
] as const;

property(
  "the summary has one line per agent with its overview counts, active automations and budget",
  Arbitrary.flatMap(agents, (list) =>
    Arbitrary.all({
      list: Arbitrary.Constant(list),
      automations: automationsFor(list.map((a) => a.id)),
      overviews: Arbitrary.all(
        list.map(() =>
          Arbitrary.all({
            messages: int(0, 10_000),
            last24h: Arbitrary.map(int(0, 10_000), (n) => n / 100),
            last7d: Arbitrary.map(int(0, 10_000), (n) => n / 100),
            turns: int(0, 4),
            approvals: int(0, 4),
            budget: int(0, BUDGETS.length - 1),
          }),
        ),
      ),
    }),
  ),
  async ({ list, automations, overviews }) => {
    const byDoName = new Map(list.map((a, k) => [`agent:${a.id}`, overviews[k]!]));
    const env = world(list, automations, (doName) => ({
      overview: async () => {
        const o = byDoName.get(doName)!;
        const budget = BUDGETS[o.budget]![0];
        return {
          messages: o.messages,
          spend: { last24h: o.last24h, last7d: o.last7d },
          turns: Array.from({ length: o.turns }, () => ({})),
          approvals: Array.from({ length: o.approvals }, () => ({})),
          settings: budget === undefined ? {} : { budget },
        };
      },
    }));
    const res = await call(env, "/admin/api/summary", {}, signedIn);
    expect(await res.json()).toEqual(
      list.map((a, k) => {
        const o = overviews[k]!;
        return {
          doName: `agent:${a.id}`,
          name: a.name,
          lastActive: a.lastActive,
          messages: o.messages,
          spend24h: o.last24h,
          spend7d: o.last7d,
          pending: o.turns,
          approvals: o.approvals,
          schedules: automations.filter((s) => s.agent === a.id && s.active).length,
          budget: BUDGETS[o.budget]![1],
        };
      }),
    );
  },
  { runs: 30 },
);

const BUILT_HERE = ["channels", "profile", "agents", "summary"] as const;
const BUILT_HERE_FOR_ONE_AGENT = ["overview", "schedules", "runs"] as const;

property(
  "every page the Worker builds itself decodes whole with the dashboard's schema for it",
  Arbitrary.flatMap(agents, (list) =>
    Arbitrary.all({
      list: Arbitrary.Constant(list),
      chosen: oneOf(list),
      automations: automationsFor(list.map((a) => a.id)),
      settings: oneOf([{}, { model: "m1" }, { model: "m2", budget: "2.5" }]),
      rules: Arbitrary.array(text, { maxLength: 3 }),
    }),
  ),
  async ({ list, chosen, automations, settings, rules }) => {
    const db = new DatabaseSync(":memory:");
    const sql = {
      all: <T>(query: string, ...params: unknown[]) =>
        db.prepare(query).all(...(params as never[])) as T[],
    };
    const realOverview = { ...(await overview(sql, 1_800_000_000_000)), settings };
    const base = world(list, automations);
    const automationsStub = (
      base.Automations as unknown as { getByName: () => Record<string, unknown> }
    ).getByName();
    const env: Partial<Env> = {
      ...base,
      Hub: {
        getByName: () => ({
          agents: async () => list.map(agentInfo),
          profile: async () => ({ about: "about", rules }),
        }),
      } as never,
      Automations: {
        getByName: () => ({
          ...automationsStub,
          runs: async () =>
            automations.map((a, k) => ({
              id: k + 1,
              automationId: a.id,
              status: k % 2 === 0 ? "ok" : "error",
              started: a.nextAt,
              finished: k % 2 === 0 ? a.nextAt + 1 : undefined,
              output: `out${k}`,
              error: k % 2 === 0 ? undefined : "failed",
            })),
        }),
      } as never,
      AgentObject: { getByName: () => ({ overview: async () => realOverview }) } as never,
    };
    const pages: ReadonlyArray<[ReadPage, string]> = [
      ...BUILT_HERE.map((page): [ReadPage, string] => [page, `/admin/api/${page}`]),
      ...BUILT_HERE_FOR_ONE_AGENT.map((page): [ReadPage, string] => [
        page,
        `/admin/api/${page}?c=agent%3A${chosen.id}`,
      ]),
    ];
    for (const [page, path] of pages) {
      const res = await call(env, path, {}, signedIn);
      expect(res.status).toBe(200);
      const wire: unknown = await res.json();
      expect(Schema.decodeUnknownSync(Reads[page])(wire)).toEqual(wire);
    }
  },
  { runs: 30 },
);
