import type { Env } from "../../core/env";
import { injectSharedHead } from "./shared-head";
import { renderArtifactList } from "./templates/list";

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

  const rawHtml = await obj.text();
  const html = injectSharedHead(rawHtml);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { headers });
}

export async function listArtifacts(env: Env): Promise<Response> {
  const listed = await env.MIZOOK_R2.list({ prefix: "artifacts/" });
  const base = env.BASE_URL ?? "https://mzk.elianiva.com";

  const items = listed.objects.map((obj) => {
    const name = obj.key.replace("artifacts/", "");
    const size = obj.size;
    const modified = new Date(obj.uploaded).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    return { name, size, modified, href: `${base}/artifacts/${encodeURIComponent(name)}` };
  });

  items.sort((a, b) => a.name.localeCompare(b.name));

  const html = renderArtifactList(items);

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
