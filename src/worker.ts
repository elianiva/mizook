import { Effect } from "effect";
import type { Env } from "./env.ts";
import { artifactHeaders } from "./artifacts.ts";
import { channelOf } from "./route.ts";

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
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, {
        headers: artifactHeaders(object.httpMetadata?.contentType),
      });
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

    if (pathname === "/") return new Response("mizook");
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
