import { Effect } from "effect";
import type { Env } from "./env.ts";
import { artifactHeaders, renderArtifact } from "./artifact-render.ts";
import { DATA_KEY, dataKey, dataPrefix, MAX_KEYS } from "./artifact-data.ts";
import { hookTokenValid } from "./hooks.ts";
import { channelOf } from "./route.ts";
import { handleAdmin } from "./admin/handler.ts";

export { ChatAgent } from "./chat-agent.ts";
export { Hub } from "./hub.ts";

/** Constant-time comparison of two secrets of any length. */
const sameSecret = async (a: string, b: string): Promise<boolean> => {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all(
    [a, b].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))),
  );
  return crypto.subtle.timingSafeEqual(x!, y!);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/admin" || pathname.startsWith("/admin/")) return handleAdmin(request, env);

    if (pathname === "/telegram/webhook" && request.method === "POST") {
      // Turn away anything Telegram did not send before it wakes the chat.
      const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!(await sameSecret(secret, env.MIZOOK_WEBHOOK_SECRET))) {
        return new Response("Unauthorized", { status: 401 });
      }
      // One Durable Object per forum topic: each topic is its own endless chat.
      const body = await request.text();
      const channel = await Effect.runPromise(Effect.option(channelOf(body)));
      if (channel._tag === "None") return new Response("Bad request", { status: 400 });
      return env.ChatAgent.getByName(channel.value).fetch(
        new Request(request.url, { method: "POST", headers: request.headers, body }),
      );
    }

    // Published artifacts: the token is the secret. The policy gives the page an opaque origin, so
    // its scripts can run but cannot read this site's storage or call it as the user.
    const artifact = /^\/a\/([\w-]{16,64})(?:\/.*)?$/.exec(pathname);
    if (artifact && request.method === "GET") {
      const object = await env.Files.get(`a/${artifact[1]}`);
      const expires = Number(object?.customMetadata?.expires ?? 0);
      if (!object || (expires > 0 && Date.now() > expires)) {
        return new Response("Not found", { status: 404 });
      }
      const type = object.httpMetadata?.contentType ?? "text/plain; charset=utf-8";
      const page = renderArtifact(type, await object.text(), {
        name: object.customMetadata?.name ?? "page",
        origin: new URL(request.url).origin,
        token: artifact[1]!,
      });
      return new Response(page ?? object.body, { headers: artifactHeaders(type) });
    }

    // What the agent saved for a page, read-only. The page's own token is the key. The page
    // runs in an opaque origin, so these answer any origin: the token, not the origin, is the secret.
    const data = /^\/d\/([\w-]{16,64})(?:\/([^/]*))?$/.exec(pathname);
    if (data) {
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
      };
      const reply = (body: BodyInit | null, status = 200, type = "application/json") =>
        new Response(body, {
          status,
          headers: { ...cors, "content-type": type, "cache-control": "no-store" },
        });
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const token = data[1]!;
      const page = await env.Files.head(`a/${token}`);
      const expires = Number(page?.customMetadata?.expires ?? 0);
      if (!page || (expires > 0 && Date.now() > expires))
        return reply("not found", 404, "text/plain");
      const key = data[2] === undefined ? undefined : decodeURIComponent(data[2]);

      if (key === undefined && request.method === "GET") {
        const out: Record<string, unknown> = {};
        for (const object of (await env.Files.list({ prefix: dataPrefix(token), limit: MAX_KEYS }))
          .objects) {
          const value = await env.Files.get(object.key);
          if (value) out[object.key.slice(dataPrefix(token).length)] = await value.json();
        }
        return reply(JSON.stringify(out));
      }
      if (key === undefined || !DATA_KEY.test(key)) return reply("bad key", 400, "text/plain");
      if (request.method === "GET") {
        const value = await env.Files.get(dataKey(token, key));
        return value ? reply(value.body) : reply("not found", 404, "text/plain");
      }
      return reply("method not allowed", 405, "text/plain");
    }

    // Exports: a one-hour link. The key is the secret, and the file goes when the hour is up.
    const exported = /^\/x\/([\w-]{16,64})$/.exec(pathname);
    if (exported && request.method === "GET") {
      const object = await env.Files.get(`x/${exported[1]}`);
      const expires = Number(object?.customMetadata?.expires ?? 0);
      if (!object || Date.now() > expires) {
        if (object) await env.Files.delete(`x/${exported[1]}`);
        return new Response("Not found", { status: 404 });
      }
      return new Response(object.body, {
        headers: {
          "content-type": "application/x-tar",
          "content-disposition": `attachment; filename="${object.customMetadata?.filename ?? "export"}"`,
          "cache-control": "no-store",
        },
      });
    }

    // Webhooks: the token is an HMAC of the channel name, so a link works for one channel only.
    const hooked = /^\/hook\/([^/]+)\/([\w-]{16,64})$/.exec(pathname);
    if (hooked && request.method === "POST") {
      const channel = decodeURIComponent(hooked[1]!);
      if (!(await hookTokenValid(env.MIZOOK_WEBHOOK_SECRET, channel, hooked[2]!))) {
        return new Response("Not found", { status: 404 });
      }
      const body = (await request.text()).slice(0, 100_000);
      const stub = env.ChatAgent.getByName(channel) as unknown as {
        hook(body: string): Promise<boolean>;
      };
      return new Response((await stub.hook(body)) ? "ok" : "ignored", { status: 202 });
    }

    if (pathname === "/") return new Response("mizook");
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
