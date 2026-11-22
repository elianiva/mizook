import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { handleChat } from "../src/chat/handler.ts";
import type { Env } from "../src/env.ts";
import type { AgentInfo, WebThreadInfo } from "../src/host.ts";

const TEAM = "chat.cloudflareaccess.com";
const AUD = "chat-aud";
const EMAIL = "me@example.com";
const ORIGIN = "https://x.test";

const b64 = (data: string | ArrayBuffer) =>
  btoa(
    Array.from(
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data),
      (byte) => String.fromCharCode(byte),
    ).join(""),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

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

const tokenFor = async (aud: string, email = EMAIL) => {
  const body = `${b64(JSON.stringify({ alg: "RS256", kid: "k" }))}.${b64(
    JSON.stringify({
      iss: `https://${TEAM}`,
      aud: [aud],
      exp: Date.now() / 1000 + 3600,
      email,
    }),
  )}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(body),
  );
  return `${body}.${b64(signature)}`;
};

const token = await tokenFor(AUD);

const agent = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "agent-web",
  slug: "web",
  name: "Mizook Web",
  role: "",
  persona: "",
  tools: undefined,
  doName: "agent:agent-web",
  isDefault: false,
  bound: [],
  created: 1,
  lastActive: 2,
  ...overrides,
});

const web = agent();
const mizook = agent({
  id: "agent-mizook",
  slug: "mizook",
  name: "Mizook",
  doName: "agent:agent-mizook",
  isDefault: true,
});

const thread = (overrides: Partial<WebThreadInfo> = {}): WebThreadInfo => ({
  id: "t1",
  agent: web,
  title: "First chat",
  preview: "hello",
  created: 1,
  updated: 2,
  archived: false,
  ...overrides,
});

type Calls = {
  hub: string[];
  webTurn: unknown[][];
  webState: unknown[][];
  act: unknown[][];
};

const world = (calls: Calls = { hub: [], webTurn: [], webState: [], act: [] }): Partial<Env> => {
  const agentRpc = {
    webState: async (place: string, after: number) => {
      calls.webState.push([place, after]);
      return {
        messages: [{ id: 3, role: "agent" as const, text: "hi", at: 4 }],
        running: true,
        approvals: [{ id: 7, summary: "Use Gmail?", match: "gmail.send", created: 5 }],
      };
    },
    webTurn: async (place: string, text: string, requestId: string) => {
      calls.webTurn.push([place, text, requestId]);
      return { ok: true as const, folded: false, messageId: 9, at: 10 };
    },
    webStop: async () => true,
    act: async (who: string, action: string, id: number) => {
      calls.act.push([who, action, id]);
      return true;
    },
  };
  const hub = {
    agents: async () => [mizook, web],
    webThreads: async () => [thread()],
    webThread: async (id: string) => (id === "t1" ? thread() : undefined),
    createWebThread: async (agentKey: string | undefined) => {
      calls.hub.push(`create:${agentKey ?? ""}`);
      return thread({ agent: agentKey === "mizook" ? mizook : web, title: "New chat" });
    },
    renameWebThread: async (id: string, title: string) => {
      calls.hub.push(`rename:${id}:${title}`);
      return thread({ title });
    },
    archiveWebThread: async (id: string) => {
      calls.hub.push(`archive:${id}`);
      return id === "t1";
    },
    webDefaultAgent: async () => web,
  };
  return {
    ACCESS_TEAM_DOMAIN: TEAM,
    CHAT_ACCESS_AUD: AUD,
    Hub: { getByName: () => hub } as never,
    AgentObject: { getByName: () => agentRpc } as never,
  };
};

const call = (
  env: Partial<Env>,
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
) => handleChat(new Request(`${ORIGIN}${path}`, { ...init, headers }), env as Env);

const signedIn = { "cf-access-jwt-assertion": token };
const writer = { ...signedIn, "x-mizook-csrf": "1", origin: ORIGIN };

beforeEach(() => {
  vi.stubGlobal("fetch", async () =>
    Response.json({ keys: [{ kid: "k", kty: "RSA", n: jwk.n, e: jwk.e }] }),
  );
});

afterEach(() => vi.unstubAllGlobals());

test("the chat is shut until its own Access audience exists", async () => {
  const touched: string[] = [];
  const env = {
    ...world({
      hub: [],
      webTurn: [],
      webState: [],
      act: [],
    }),
    CHAT_ACCESS_AUD: undefined,
    Hub: {
      getByName: () => {
        touched.push("hub");
        return {};
      },
    } as never,
  };
  expect((await call(env, "/c/api/bootstrap", {}, signedIn)).status).toBe(503);
  expect(
    (await call({ ...env, CHAT_ACCESS_AUD: "" }, "/c/api/bootstrap", {}, signedIn)).status,
  ).toBe(503);
  expect(touched).toEqual([]);
});

test("a token for another audience and a write without the same-origin header are refused", async () => {
  const calls: Calls = { hub: [], webTurn: [], webState: [], act: [] };
  const env = world(calls);
  expect(
    (
      await call(
        env,
        "/c/api/bootstrap",
        {},
        { "cf-access-jwt-assertion": await tokenFor("some-other-app") },
      )
    ).status,
  ).toBe(403);
  expect((await call(env, "/c/api/threads", { method: "POST" }, signedIn)).status).toBe(403);
  expect((await call(env, "/c/api/threads", { method: "POST", body: "{}" }, writer)).status).toBe(
    201,
  );
  expect(calls.hub).toEqual(["create:"]);
  expect(calls.webTurn).toEqual([]);
});

test("bootstrap lists agents and web threads, marks the web default, and does not leak other fields", async () => {
  const env = world();
  const response = await call(env, "/c/api/bootstrap", {}, signedIn);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    agents: [
      {
        id: "agent-mizook",
        slug: "mizook",
        name: "Mizook",
        isDefault: true,
        isWebDefault: false,
      },
      {
        id: "agent-web",
        slug: "web",
        name: "Mizook Web",
        isDefault: false,
        isWebDefault: true,
      },
    ],
    threads: [
      {
        id: "t1",
        title: "First chat",
        preview: "hello",
        created: 1,
        updated: 2,
        agent: { slug: "web", name: "Mizook Web" },
      },
    ],
    defaultAgent: { slug: "web", name: "Mizook Web" },
  });
});

test("a thread read asks that thread's agent for messages after the given id", async () => {
  const calls: Calls = { hub: [], webTurn: [], webState: [], act: [] };
  const response = await call(world(calls), "/c/api/threads/t1?after=4", {}, signedIn);
  expect(response.status).toBe(200);
  expect(calls.webState).toEqual([["web:t1", 4]]);
  expect(await response.json()).toEqual({
    thread: {
      id: "t1",
      title: "First chat",
      preview: "hello",
      created: 1,
      updated: 2,
      agent: { slug: "web", name: "Mizook Web" },
    },
    messages: [{ id: 3, role: "agent", text: "hi", at: 4 }],
    running: true,
    approvals: [{ id: 7, summary: "Use Gmail?", match: "gmail.send", created: 5 }],
  });
});

test("a message is trimmed and starts a web turn in the thread's place", async () => {
  const calls: Calls = { hub: [], webTurn: [], webState: [], act: [] };
  const response = await call(
    world(calls),
    "/c/api/threads/t1/messages",
    { method: "POST", body: JSON.stringify({ text: "  hello  ", requestId: "req-1" }) },
    writer,
  );
  expect(response.status).toBe(200);
  expect(calls.webTurn).toEqual([["web:t1", "hello", "req-1"]]);
  expect(await response.json()).toEqual({
    ok: true,
    folded: false,
    messageId: 9,
    at: 10,
    thread: {
      id: "t1",
      title: "First chat",
      preview: "hello",
      created: 1,
      updated: 2,
      agent: { slug: "web", name: "Mizook Web" },
    },
  });
});

test("an approval is acted on by the thread's agent as the signed-in person", async () => {
  const calls: Calls = { hub: [], webTurn: [], webState: [], act: [] };
  const response = await call(
    world(calls),
    "/c/api/approvals/7",
    { method: "POST", body: JSON.stringify({ action: "always", thread: "t1" }) },
    writer,
  );
  expect(response.status).toBe(200);
  expect(calls.act).toEqual([[EMAIL, "always", 7]]);
});

test("renaming and archiving go to the hub, and the old API prefix is not a chat route", async () => {
  const calls: Calls = { hub: [], webTurn: [], webState: [], act: [] };
  const env = world(calls);
  const renamed = await call(
    env,
    "/c/api/threads/t1",
    { method: "PATCH", body: JSON.stringify({ title: "  New name  " }) },
    writer,
  );
  expect(renamed.status).toBe(200);
  expect(calls.hub).toEqual(["rename:t1:  New name  "]);
  expect((await call(env, "/c/api/threads/t1/archive", { method: "POST" }, writer)).status).toBe(
    200,
  );
  expect(calls.hub).toEqual(["rename:t1:  New name  ", "archive:t1"]);
  expect((await call(env, "/api/chat/bootstrap", {}, signedIn)).status).toBe(404);
});
