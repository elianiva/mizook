import type { Env } from "../../core/env";

export async function serveScreenshot(url: URL, env: Env): Promise<Response> {
  const prefix = "/screenshots/";
  const key = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!key || !key.startsWith("screenshots/")) {
    return new Response("Not found", { status: 404 });
  }
  const obj = await env.SCREENSHOTS.get(key);
  if (!obj) {
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(obj.body, { headers });
}
