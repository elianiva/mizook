import { marked } from "marked";
import { Option, Schema } from "effect";

/** What the Worker does with a published file. Markdown, charts and tables become pages; the rest is served as it is. */
export type Kind = "html" | "markdown" | "chart" | "table" | "file";

export const KIND_TYPES = {
  html: "text/html; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  chart: "application/vnd.mizook.chart+json",
  table: "application/vnd.mizook.table+json",
} as const;

export const kindOf = (contentType: string): Kind => {
  if (/^text\/html/i.test(contentType)) return "html";
  if (/^text\/markdown/i.test(contentType)) return "markdown";
  if (contentType === KIND_TYPES.chart) return "chart";
  if (contentType === KIND_TYPES.table) return "table";
  return "file";
};

/** Library hosts a page may load scripts and styles from. A short list, as in Claude's artifacts. */
export const CDNS = [
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://cdnjs.cloudflare.com",
  "https://cdn.tailwindcss.com",
] as const;

const FONT_STYLES = "https://fonts.googleapis.com";
const FONT_FILES = "https://fonts.gstatic.com";

/** Headers for a served page. Every kind runs in a sandbox with its own opaque origin. */
export const artifactHeaders = (contentType: string): Headers => {
  const kind = kindOf(contentType);
  const scripts =
    kind === "markdown"
      ? "script-src 'none'"
      : `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS.join(" ")}`;
  return new Headers({
    "content-type": kind === "file" ? contentType : "text/html; charset=utf-8",
    "content-security-policy": [
      "sandbox allow-scripts allow-forms allow-popups allow-modals",
      "default-src 'none'",
      scripts,
      `style-src 'unsafe-inline' ${CDNS.join(" ")} ${FONT_STYLES}`,
      "img-src data: blob: https:",
      `font-src data: ${FONT_FILES} ${CDNS.join(" ")}`,
      "media-src data: blob: https:",
      "connect-src https:",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
  });
};

const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** JSON safe to place inside a <script> element. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028|\u2029/g, " ");

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** The design the templates share: type, colour and spacing tokens, light and dark. */
export const BASE_CSS = `
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#ffffff;--line:#e7e5e4;--accent:#4f46e5;--accent-fg:#ffffff;--code:#f5f5f4;--radius:12px;--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e7e5e4;--muted:#a8a29e;--card:#181b21;--line:#2a2e36;--accent:#818cf8;--accent-fg:#0f1115;--code:#1e2229}}
:where(*,*::before,*::after){box-sizing:border-box}
:where(html){-webkit-text-size-adjust:100%}
:where(body){margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 var(--font);-webkit-font-smoothing:antialiased}
:where(h1,h2,h3,h4){line-height:1.25;margin:1.6em 0 .5em;letter-spacing:-.01em}
:where(h1){font-size:1.75rem;margin-top:0}:where(h2){font-size:1.35rem}:where(h3){font-size:1.1rem}
:where(p,ul,ol,blockquote,pre,table){margin:0 0 1em}
:where(a){color:var(--accent);text-underline-offset:2px}
:where(img,svg,video,canvas){max-width:100%;height:auto}
:where(code){font:.9em var(--mono);background:var(--code);padding:.15em .35em;border-radius:6px}
:where(pre){background:var(--code);padding:14px 16px;border-radius:var(--radius);overflow:auto}
:where(pre code){background:none;padding:0}
:where(blockquote){border-left:3px solid var(--line);margin-left:0;padding:.1em 1em;color:var(--muted)}
:where(hr){border:0;border-top:1px solid var(--line);margin:2em 0}
:where(table){border-collapse:collapse;width:100%}
:where(th,td){padding:.55em .8em;text-align:left;border-bottom:1px solid var(--line)}
:where(th){font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
:where(button,input,select,textarea){font:inherit;color:inherit}
:where(button){background:var(--accent);color:var(--accent-fg);border:0;border-radius:10px;padding:.55em 1em;cursor:pointer}
:where(input,select,textarea){background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.5em .75em}
:where(input[type=checkbox]){accent-color:var(--accent)}
`;

const TEMPLATE_CSS = `
.page{max-width:44rem;margin:0 auto;padding:clamp(20px,5vw,48px) clamp(16px,5vw,32px) 64px}
.page.wide{max-width:70rem}
.page>header{margin-bottom:1.5rem}
.page>header h1{margin:0 0 .25rem}
.page>header p{margin:0;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:clamp(14px,3vw,24px)}
.table-wrap{overflow:auto;max-height:75vh;border:1px solid var(--line);border-radius:var(--radius);background:var(--card)}
.table-wrap table{margin:0;min-width:100%}
.table-wrap th{position:sticky;top:0;background:var(--card);cursor:pointer;white-space:nowrap;user-select:none}
.table-wrap tbody tr:last-child td{border-bottom:0}
.table-wrap tbody tr:nth-child(even){background:color-mix(in srgb,var(--code) 55%,transparent)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.tools{display:flex;gap:10px;margin-bottom:12px;align-items:center}
.tools input{flex:1;min-width:0}
.tools .count{color:var(--muted);font-size:.85rem;white-space:nowrap}
.chart-box{position:relative;height:min(60vh,420px)}
.doc :where(h1){font-size:2rem}
.doc :where(img){border-radius:var(--radius)}
.doc :where(table){display:block;overflow:auto}
.doc input[type=checkbox]{appearance:none;-webkit-appearance:none;width:1.1em;height:1.1em;border:1.5px solid var(--muted);border-radius:5px;vertical-align:-.18em;margin:0 .55em 0 0;opacity:1}
.doc input[type=checkbox]:checked{background:var(--accent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/80% no-repeat;border-color:var(--accent)}
.doc :where(ul.contains-task-list,ul:has(>li>input[type=checkbox])){list-style:none;padding-left:.2em}
`;

const meta = (title: string, description: string): string =>
  `<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#4f46e5">`;

const shell = (o: {
  title: string;
  description: string;
  body: string;
  head?: string;
  wide?: boolean;
}): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${meta(o.title, o.description)}
<style>${BASE_CSS}${TEMPLATE_CSS}</style>
${o.head ?? ""}
</head>
<body>
<main class="page${o.wide ? " wide" : ""}">
${o.body}
</main>
</body>
</html>`;

export interface Context {
  /** The file's name, used as the title when the content has none. */
  readonly name: string;
  /** The site's origin and the artifact's token, for the data calls of a page. */
  readonly origin: string;
  readonly token: string;
}

// ── markdown ───────────────────────────────────────────────────────────────

const plain = (html: string): string =>
  html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");

const renderMarkdown = (source: string, ctx: Context): string => {
  const html = marked.parse(source, { gfm: true, async: false });
  const title = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const firstParagraph = /<p>([\s\S]*?)<\/p>/i.exec(html)?.[1];
  return shell({
    title: clip(plain(title ?? ctx.name), 120),
    description: clip(plain(firstParagraph ?? source), 160),
    body: `<article class="doc">${html}</article>`,
  });
};

// ── table ──────────────────────────────────────────────────────────────────

const Cell = Schema.NullOr(Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]));
export const TableSpec = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Cell)),
});
const decodeTable = Schema.decodeUnknownOption(Schema.fromJsonString(TableSpec));

const TABLE_SCRIPT = `
(()=>{const t=document.querySelector("table"),b=t.tBodies[0],q=document.getElementById("q"),n=document.getElementById("n");
const rows=[...b.rows];
const val=(r,i)=>{const c=r.cells[i];return c.dataset.v??c.textContent};
let dir=1,col=-1;
t.tHead.addEventListener("click",e=>{const th=e.target.closest("th");if(!th)return;const i=th.cellIndex;dir=col===i?-dir:1;col=i;
rows.sort((a,c)=>{const x=val(a,i),y=val(c,i),nx=parseFloat(x),ny=parseFloat(y);
return (isNaN(nx)||isNaN(ny)?String(x).localeCompare(String(y)):nx-ny)*dir});
rows.forEach(r=>b.appendChild(r));[...t.tHead.rows[0].cells].forEach((c,j)=>c.dataset.sort=j===i?(dir>0?"▲":"▼"):"")});
const filter=()=>{const s=q.value.toLowerCase();let k=0;rows.forEach(r=>{const ok=r.textContent.toLowerCase().includes(s);r.hidden=!ok;if(ok)k++});n.textContent=k+" of "+rows.length};
q.addEventListener("input",filter);filter()})();`;

const renderTable = (source: string, ctx: Context): string => {
  const spec = decodeTable(source);
  if (Option.isNone(spec)) return renderError("This table's data is not valid.", ctx);
  const { title = ctx.name, description, columns, rows } = spec.value;
  const numeric = columns.map(
    (_, i) => rows.length > 0 && rows.every((r) => r[i] == null || typeof r[i] === "number"),
  );
  const head = columns
    .map((c, i) => `<th${numeric[i] ? ' class="num"' : ""}>${esc(c)}</th>`)
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${columns
          .map((_, i) => {
            const v = r[i] ?? "";
            return `<td${numeric[i] ? ' class="num"' : ""} data-v="${esc(String(v))}">${esc(typeof v === "number" ? v.toLocaleString("en") : String(v))}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return shell({
    title: clip(title, 120),
    description: clip(description ?? `${rows.length} rows, ${columns.length} columns`, 160),
    wide: columns.length > 4,
    body: `<header><h1>${esc(title)}</h1>${description ? `<p>${esc(description)}</p>` : ""}</header>
<div class="tools"><input id="q" type="search" placeholder="Filter" aria-label="Filter rows"><span class="count" id="n"></span></div>
<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
<style>th[data-sort]::after{content:" " attr(data-sort);color:var(--accent)}</style>
<script>${TABLE_SCRIPT}</script>`,
  });
};

// ── chart ──────────────────────────────────────────────────────────────────

export const ChartSpec = Schema.Struct({
  type: Schema.Literals(["bar", "line", "pie", "doughnut", "radar"]),
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  labels: Schema.Array(Schema.String),
  datasets: Schema.Array(
    Schema.Struct({ label: Schema.String, data: Schema.Array(Schema.Finite) }),
  ),
});
const decodeChart = Schema.decodeUnknownOption(Schema.fromJsonString(ChartSpec));

const CHART_JS = "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js";

const CHART_SCRIPT = `
(()=>{const spec=JSON.parse(document.getElementById("spec").textContent);
const css=getComputedStyle(document.documentElement);
const fg=css.getPropertyValue("--fg").trim(),muted=css.getPropertyValue("--muted").trim(),line=css.getPropertyValue("--line").trim();
const palette=["#6366f1","#f59e0b","#10b981","#ef4444","#06b6d4","#a855f7","#84cc16","#f97316"];
const round=spec.type==="pie"||spec.type==="doughnut";
const datasets=spec.datasets.map((d,i)=>({label:d.label,data:d.data,
backgroundColor:round?spec.labels.map((_,j)=>palette[j%palette.length]):palette[i%palette.length]+(spec.type==="line"||spec.type==="radar"?"33":"cc"),
borderColor:round?css.getPropertyValue("--card").trim():palette[i%palette.length],borderWidth:round?2:2,tension:.3,borderRadius:spec.type==="bar"?6:0,fill:spec.type==="radar"}));
Chart.defaults.color=muted;Chart.defaults.font.family=css.getPropertyValue("--font");
new Chart(document.getElementById("c"),{type:spec.type,data:{labels:spec.labels,datasets},options:{responsive:true,maintainAspectRatio:false,
plugins:{legend:{display:round||spec.datasets.length>1,labels:{color:fg,usePointStyle:true}}},
scales:round||spec.type==="radar"?{}:{x:{grid:{display:false}},y:{grid:{color:line},beginAtZero:true}}}});})();`;

const renderChart = (source: string, ctx: Context): string => {
  const spec = decodeChart(source);
  if (Option.isNone(spec)) return renderError("This chart's data is not valid.", ctx);
  const { title = ctx.name, description, labels, datasets } = spec.value;
  const rows = labels
    .map(
      (l, i) =>
        `<tr><td>${esc(l)}</td>${datasets.map((d) => `<td class="num">${(d.data[i] ?? "").toLocaleString("en")}</td>`).join("")}</tr>`,
    )
    .join("");
  return shell({
    title: clip(title, 120),
    description: clip(description ?? datasets.map((d) => d.label).join(", "), 160),
    body: `<header><h1>${esc(title)}</h1>${description ? `<p>${esc(description)}</p>` : ""}</header>
<div class="card"><div class="chart-box"><canvas id="c" role="img" aria-label="${esc(title)}"></canvas></div></div>
<details style="margin-top:1rem"><summary style="cursor:pointer;color:var(--muted)">Data</summary>
<div class="table-wrap" style="margin-top:.5rem"><table><thead><tr><th></th>${datasets.map((d) => `<th class="num">${esc(d.label)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div></details>
<script id="spec" type="application/json">${scriptJson(spec.value)}</script>
<script src="${CHART_JS}"></script>
<script>${CHART_SCRIPT}</script>`,
  });
};

// ── html ───────────────────────────────────────────────────────────────────

/** What a page can call: the data saved for it, read-only. Keyed by the page's link. */
const bridge = (ctx: Context): string => `<script>
(()=>{const base=${scriptJson(ctx.origin)}+"/d/"+${scriptJson(ctx.token)};
const call=async path=>{const r=await fetch(base+path);if(!r.ok)throw new Error(await r.text());return r.status===204?null:r.json()};
window.mizook={data:{
all:()=>call(""),
get:async k=>{const r=await fetch(base+"/"+encodeURIComponent(k));return r.status===404?null:r.json()}}};})();
</script>`;

const injectedHead = (
  title: string,
  description: string,
  ctx: Context,
  has: { meta: boolean; viewport: boolean },
): string =>
  [
    has.viewport
      ? ""
      : '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    has.meta ? "" : meta(title, description),
    `<style id="mizook-base">${BASE_CSS}</style>`,
    bridge(ctx),
  ].join("\n");

const renderHtml = (source: string, ctx: Context): string => {
  const title = clip(
    plain(
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] ??
        /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(source)?.[1] ??
        ctx.name,
    ),
    120,
  );
  const described =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(source)?.[1] ??
    clip(plain(source.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")), 160);
  const has = {
    meta: /<meta[^>]+property=["']og:title["']/i.test(source) || /<title[\s>]/i.test(source),
    viewport: /<meta[^>]+name=["']viewport["']/i.test(source),
  };
  const head = injectedHead(title, described, ctx, has);
  if (/<head[\s>]/i.test(source)) return source.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`);
  if (/<html[\s>]/i.test(source))
    return source.replace(
      /<html[^>]*>/i,
      (m) => `${m}\n<head><meta charset="utf-8">\n${head}</head>`,
    );
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n${head}</head>\n<body>\n${source}\n</body></html>`;
};

const renderError = (message: string, ctx: Context): string =>
  shell({
    title: ctx.name,
    description: message,
    body: `<div class="card"><p>${esc(message)}</p></div>`,
  });

/**
 * The page for a published file, drawn when it is opened, so a change to a template reaches every page
 * already published. A file that is not a page kind comes back as it is.
 */
export const renderArtifact = (
  contentType: string,
  source: string,
  ctx: Context,
): string | undefined => {
  switch (kindOf(contentType)) {
    case "markdown":
      return renderMarkdown(source, ctx);
    case "table":
      return renderTable(source, ctx);
    case "chart":
      return renderChart(source, ctx);
    case "html":
      return renderHtml(source, ctx);
    case "file":
      return undefined;
  }
};

/** Why a file cannot be published as this kind, or `undefined` when it is fine. */
export const checkContent = (contentType: string, source: string): string | undefined => {
  switch (kindOf(contentType)) {
    case "table":
      return Option.isNone(decodeTable(source))
        ? 'a table is JSON: {"title"?, "description"?, "columns": ["A","B"], "rows": [["x", 1], …]}'
        : undefined;
    case "chart":
      return Option.isNone(decodeChart(source))
        ? 'a chart is JSON: {"type": "bar"|"line"|"pie"|"doughnut"|"radar", "title"?, "labels": [...], "datasets": [{"label": "…", "data": [numbers]}]}'
        : undefined;
    default:
      return undefined;
  }
};
