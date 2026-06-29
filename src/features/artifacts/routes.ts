import type { Env } from "../../core/env";

export async function serveArtifact(url: URL, env: Env): Promise<Response> {
  const prefix = "/artifacts/";
  const name = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!name) {
    return new Response("Not found", { status: 404 });
  }

  const key = `artifacts/${name}`;
  const obj = await env.MIZOOK_R2.get(key);
  if (!obj) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(obj.body, { headers });
}
