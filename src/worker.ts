import { Effect, Option } from "effect";
import { WebChat } from "@mizook/chat-sync";
import { ProtocolError } from "@yielded/sync";
import { Cloudflare } from "@yielded/sync-platform-cloudflare";
import type { Env } from "./env.ts";
import { artifactHeaders, renderArtifact } from "./artifact-render.ts";
import { DATA_KEY, dataKey, dataPrefix, MAX_KEYS } from "./artifact-data.ts";
import { hookTokenValid } from "./hooks.ts";
import { routeOf } from "./route.ts";
import { agentObject, automationsObject, hubObject } from "./objects.ts";
import { handleAdmin } from "./admin/handler.ts";
import { accessWho, verifierFor } from "./admin/access.ts";
import { serveWebMedia, uploadWebMedia } from "./uploads.ts";

export { AgentObject } from "./agent-object.ts";
export { Hub } from "./hub.ts";
export { AutomationsObject } from "./automations-object.ts";
export { WebChatObject } from "./web-chat-object.ts";

const secretsEqualInConstantTime = async (a: string, b: string): Promise<boolean> => {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all(
    [a, b].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))),
  );
  return crypto.subtle.timingSafeEqual(x!, y!);
};

const PUBLISHED_ARTIFACT_PATH = /^\/a\/([\w-]{16,64})(?:\/.*)?$/;
const ARTIFACT_DATA_PATH = /^\/d\/([\w-]{16,64})(?:\/([^/]*))?$/;
const ONE_HOUR_EXPORT_PATH = /^\/x\/([\w-]{16,64})$/;
const AUTOMATION_HOOK_PATH = /^\/hook\/(\d+)\/([\w-]{16,64})$/;
const WEB_MEDIA_PATH = /^\/c\/media\/([\w-]+\.(?:png|jpe?g|webp|gif|avif))$/;
const MAX_HOOK_BODY_CHARS = 100_000;

const isPubliclyVisibleArtifact = <T extends R2Object>(object: T | null): object is T => {
  if (!object || object.customMetadata?.visibility === "private") return false;
  const expiresAtMs = Number(object.customMetadata?.expires ?? 0);
  const hasExpiry = expiresAtMs > 0;
  return !hasExpiry || Date.now() <= expiresAtMs;
};

const ANY_ORIGIN_READ_ONLY_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const WEB_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob: https:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const SERVICE_WORKER_PATH = "/sw.js";
const WEB_MANIFEST_PATH = "/manifest.webmanifest";

const looksLikeAFile = (pathname: string) => /\.[a-z0-9]+$/i.test(pathname);

const serveWebApp = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (!env.ASSETS) return new Response("The web app is not built", { status: 503 });
  const isFile = looksLikeAFile(url.pathname);
  // The asset layer redirects /index.html to the root, so ask for the root.
  const asset = await env.ASSETS.fetch(isFile ? request : new Request(new URL("/", url), request));
  const response = new Response(asset.body, asset);
  // The service worker follows Access sign-in redirects across origins, which
  // the document's connect-src policy is not meant to cover.
  if (url.pathname !== SERVICE_WORKER_PATH) {
    response.headers.set("content-security-policy", WEB_CONTENT_SECURITY_POLICY);
  }
  if (url.pathname === SERVICE_WORKER_PATH) response.headers.set("cache-control", "no-cache");
  if (url.pathname === WEB_MANIFEST_PATH) {
    response.headers.set("content-type", "application/manifest+json");
  }
  response.headers.set("x-content-type-options", "nosniff");
  if (!isFile) {
    response.headers.set("cache-control", "no-store");
    const actor = await accessWho(request, env, env.CHAT_ACCESS_AUD);
    if (actor !== undefined) {
      const secure = url.protocol === "https:" ? "; Secure" : "";
      response.headers.append(
        "set-cookie",
        `mizook_actor=${encodeURIComponent(actor)}; Path=/; Max-Age=86400; SameSite=Lax${secure}`,
      );
    }
  }
  return response;
};

const webChatHandler = (env: Env) =>
  Cloudflare.handler(WebChat, {
    authenticate: (request) =>
      Effect.gen(function* () {
        if (verifierFor(env, env.CHAT_ACCESS_AUD) === undefined)
          return yield* new ProtocolError({
            reason: "Unavailable",
            message: "The web chat is not configured.",
          });
        const actor = yield* Effect.promise(() => accessWho(request, env, env.CHAT_ACCESS_AUD));
        if (actor === undefined)
          return yield* new ProtocolError({
            reason: "Unauthenticated",
            message: "Your session expired. Reload the page.",
          });
        return {
          principal: actor,
          actorId: actor,
          expiresAtMillis: Date.now() + 24 * 3_600_000,
        };
      }),
    objectName: () => "web-chat",
    fetch: (name, request) => Effect.promise(() => env.WebChat.getByName(name).fetch(request)),
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/") {
      return Response.redirect(new URL("/c", url).toString(), 302);
    }

    if (pathname === "/admin" || pathname.startsWith("/admin/")) return handleAdmin(request, env);
    if (pathname === "/c/sync" || pathname.startsWith("/c/sync/"))
      return Effect.runPromise(webChatHandler(env)(request));
    if (pathname === "/c/upload" && request.method === "POST") return uploadWebMedia(request, env);
    const media = WEB_MEDIA_PATH.exec(pathname);
    if (media !== null && (request.method === "GET" || request.method === "HEAD"))
      return serveWebMedia(request, env, media[1]!);

    if (pathname === "/telegram/webhook" && request.method === "POST") {
      const secretSentByTelegram = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!(await secretsEqualInConstantTime(secretSentByTelegram, env.MIZOOK_WEBHOOK_SECRET))) {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = await request.text();
      const routing = await Effect.runPromise(Effect.option(routeOf(body)));
      if (Option.isNone(routing)) return new Response("Bad request", { status: 400 });
      const { place, command, agentId } = routing.value;
      const agentForUpdate = await hubObject(env).route(place, command, agentId);
      return agentObject(env, agentForUpdate.doName).fetch(
        new Request(request.url, { method: "POST", headers: request.headers, body }),
      );
    }

    const artifact = PUBLISHED_ARTIFACT_PATH.exec(pathname);
    if (artifact && request.method === "GET") {
      const object = await env.Files.get(`a/${artifact[1]}`);
      if (!isPubliclyVisibleArtifact(object)) {
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

    const data = ARTIFACT_DATA_PATH.exec(pathname);
    if (data) {
      const cors = ANY_ORIGIN_READ_ONLY_CORS;
      const reply = (body: BodyInit | null, status = 200, type = "application/json") =>
        new Response(body, {
          status,
          headers: { ...cors, "content-type": type, "cache-control": "no-store" },
        });
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const pageToken = data[1]!;
      const page = await env.Files.head(`a/${pageToken}`);
      if (!isPubliclyVisibleArtifact(page)) return reply("not found", 404, "text/plain");
      const key = data[2] === undefined ? undefined : decodeURIComponent(data[2]);

      if (key === undefined && request.method === "GET") {
        const out: Record<string, unknown> = {};
        for (const object of (
          await env.Files.list({ prefix: dataPrefix(pageToken), limit: MAX_KEYS })
        ).objects) {
          const value = await env.Files.get(object.key);
          if (value) out[object.key.slice(dataPrefix(pageToken).length)] = await value.json();
        }
        return reply(JSON.stringify(out));
      }
      if (key === undefined || !DATA_KEY.test(key)) return reply("bad key", 400, "text/plain");
      if (request.method === "GET") {
        const value = await env.Files.get(dataKey(pageToken, key));
        return value ? reply(value.body) : reply("not found", 404, "text/plain");
      }
      return reply("method not allowed", 405, "text/plain");
    }

    const exported = ONE_HOUR_EXPORT_PATH.exec(pathname);
    if (exported && request.method === "GET") {
      const object = await env.Files.get(`x/${exported[1]}`);
      const expiresAtMs = Number(object?.customMetadata?.expires ?? 0);
      if (!object || Date.now() > expiresAtMs) {
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

    const hooked = AUTOMATION_HOOK_PATH.exec(pathname);
    if (hooked && request.method === "POST") {
      const id = Number(hooked[1]);
      const tokenSignedForThisAutomation = hooked[2]!;
      if (
        !(await Effect.runPromise(
          hookTokenValid(env.MIZOOK_WEBHOOK_SECRET, `auto:${id}`, tokenSignedForThisAutomation),
        ))
      ) {
        return new Response("Not found", { status: 404 });
      }
      const body = (await request.text()).slice(0, MAX_HOOK_BODY_CHARS);
      return new Response((await automationsObject(env).hook(id, body)) ? "ok" : "ignored", {
        status: 202,
      });
    }

    if (request.method === "GET" || request.method === "HEAD")
      return serveWebApp(request, env, new URL(request.url));
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
