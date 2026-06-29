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

  // Sort alphabetically by name
  items.sort((a, b) => a.name.localeCompare(b.name));

  const rows = items
    .map(
      (item) => `
        <tr>
          <td><a href="${item.href}">${item.name}</a></td>
          <td>${item.modified}</td>
          <td>${formatSize(item.size)}</td>
        </tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>mizook</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      color: #2F3437;
      background: #FBFBFA;
      line-height: 1.6;
      padding: 4rem 2rem;
    }

    main {
      max-width: 640px;
      margin: 0 auto;
    }

    h1 {
      font-size: 1.5rem;
      font-weight: 400;
      letter-spacing: -0.02em;
      margin-bottom: 0.25rem;
    }

    .subtitle {
      font-size: 0.875rem;
      color: #787774;
      margin-bottom: 3rem;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    tr {
      border-bottom: 1px solid #EAEAEA;
    }

    td {
      padding: 0.75rem 0;
      font-size: 0.9375rem;
    }

    td:first-child {
      width: 50%;
    }

    td:nth-child(2) {
      width: 30%;
      color: #787774;
      font-size: 0.8125rem;
    }

    td:last-child {
      width: 20%;
      color: #787774;
      font-size: 0.8125rem;
      text-align: right;
    }

    a {
      color: #2F3437;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .empty {
      color: #787774;
      font-style: italic;
      font-size: 0.9375rem;
      padding: 1.5rem 0;
    }
  </style>
</head>
<body>
  <main>
    <h1>mizook</h1>
    <p class="subtitle">${items.length} artifact${items.length === 1 ? "" : "s"}</p>
    <table>
      <tbody>
        ${rows || '<tr><td class="empty">No artifacts yet.</td></tr>'}
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
