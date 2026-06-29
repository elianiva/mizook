import type { Env } from "../../core/env";
import { injectSharedHead } from "./shared-head";

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

  const rows = items
    .map(
      (item) => `
        <tr class="border-b border-border">
          <td class="py-3 w-1/2"><a href="${item.href}" class="text-foreground hover:underline">${item.name}</a></td>
          <td class="py-3 w-[30%] text-muted-foreground text-sm">${item.modified}</td>
          <td class="py-3 w-[20%] text-muted-foreground text-sm text-right">${formatSize(item.size)}</td>
        </tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>mizook</title>
  <script src="/assets/tailwind-browser.js"></script>
  <script src="/assets/alpine.min.js" defer></script>
  <link rel="stylesheet" href="/assets/shared.css">
</head>
<body class="bg-background text-foreground font-sans antialiased">
  <main class="max-w-xl mx-auto px-8 py-16">
    <h1 class="font-heading text-2xl font-medium tracking-tight mb-1">mizook</h1>
    <p class="text-muted-foreground text-sm mb-12">${items.length} artifact${items.length === 1 ? "" : "s"}</p>
    <table class="w-full">
      <tbody>
        ${rows || '<tr><td class="py-6 text-muted-foreground italic text-sm">No artifacts yet.</td></tr>'}
      </tbody>
    </table>
  </main>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
