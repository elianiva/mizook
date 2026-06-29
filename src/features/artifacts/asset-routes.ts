import type { Env } from "../../core/env";

const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

export async function serveAsset(url: URL, env: Env): Promise<Response> {
  const name = url.pathname.replace("/assets/", "");
  if (!name) {
    return new Response("Not found", { status: 404 });
  }

  const key = `assets/${name}`;
  const obj = await env.MIZOOK_R2.get(key);
  if (!obj) {
    return new Response("Not found", { status: 404 });
  }

  const ext = name.slice(name.lastIndexOf("."));
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", ASSET_CACHE_CONTROL);
  headers.set("Content-Type", contentType);
  return new Response(obj.body, { headers });
}
