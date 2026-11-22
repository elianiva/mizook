import { marked } from "marked";
import { Option, Schema } from "effect";

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

export const CDNS = [
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://cdnjs.cloudflare.com",
  "https://cdn.tailwindcss.com",
] as const;

const FONT_STYLES = "https://fonts.googleapis.com";
const ALLOW_EXTENSION_FRAMES = "frame-src chrome-extension: moz-extension:";
const FONT_FILES = "https://fonts.gstatic.com";

export const artifactHeaders = (contentType: string): Headers => {
  const kind = kindOf(contentType);
  const scriptPolicy =
    kind === "markdown"
      ? "script-src 'none'"
      : `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS.join(" ")}`;
  return new Headers({
    "content-type": kind === "file" ? contentType : "text/html; charset=utf-8",
    "content-security-policy": [
      "sandbox allow-scripts allow-forms allow-popups allow-modals",
      "default-src 'none'",
      scriptPolicy,
      `style-src 'unsafe-inline' ${CDNS.join(" ")} ${FONT_STYLES}`,
      "img-src data: blob: https:",
      `font-src data: ${FONT_FILES} ${CDNS.join(" ")}`,
      "media-src data: blob: https:",
      "connect-src https:",
      ALLOW_EXTENSION_FRAMES,
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
  });
};

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const jsonSafeInScriptTag = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028|\u2029/g, " ");

const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 160;

const clipToOneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

export const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">`;

export const BASE_CSS = `
:root{color-scheme:light dark;--bg:oklch(100% 0 0);--subtle:oklch(98.6% .008 343);--fg:oklch(28.4% .109 3.9);--muted:oklch(54.2% .034 322.5);--line:oklch(93% .03 343);--line-strong:oklch(84% .06 343);--accent:oklch(52.5% .223 4);--accent-soft:oklch(89.9% .061 343);--tint:oklch(95.5% .03 343);--code:oklch(97% .012 343);--measure:48rem;--text-sm:.875rem;--text-base:1.0625rem;--text-lg:1.25rem;--text-xl:1.6rem;--text-2xl:clamp(2.25rem,7vw,3.25rem);--space-1:.5rem;--space-2:1rem;--space-3:2rem;--space-4:4rem;--font:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:oklch(14% .008 340);--subtle:oklch(17% .012 340);--fg:oklch(94% .02 343);--muted:oklch(70% .03 330);--line:oklch(25% .02 340);--line-strong:oklch(35% .03 340);--accent:oklch(76% .15 350);--accent-soft:oklch(32% .08 350);--tint:oklch(25% .06 350);--code:oklch(19% .012 340)}}
*,*::before,*::after{box-sizing:border-box;border-radius:0 !important}
:where(html){-webkit-text-size-adjust:100%}
::selection{background:var(--tint)}
:where(body){margin:0;background:var(--bg);color:var(--fg);font:400 var(--text-base)/1.75 var(--font);letter-spacing:-.011em;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
:where(h1,h2,h3,h4){font-weight:600;line-height:1.2;margin:2.4em 0 .7em;letter-spacing:-.03em}
:where(h1){font-size:var(--text-2xl);line-height:1.08;margin-top:0;letter-spacing:-.045em}:where(h2){font-size:var(--text-xl);letter-spacing:-.035em}:where(h3){font-size:var(--text-lg);letter-spacing:-.025em}:where(h4){font-size:.95rem}
:where(p,ul,ol,blockquote,pre,table){margin:0 0 1.2em}
:where(h2){margin-top:3.2em}
:where(rt){font-size:.55em;color:var(--muted);letter-spacing:0}
:where(details){margin:0 0 .5em}
:where(details>summary){cursor:pointer;list-style:none;color:var(--fg);padding:.35em 0}
:where(details>summary)::-webkit-details-marker{display:none}
:where(details>summary)::before{content:"+";font-family:var(--mono);display:inline-block;width:1.4em;color:var(--muted)}
:where(details[open]>summary)::before{content:"\\2212"}
:where(details[open]){padding-bottom:.6em}
:where(li+li){margin-top:.35em}
:where(a){color:var(--accent);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
:where(img,svg,video,canvas){max-width:100%;height:auto}
:where(code){font:400 .85em var(--mono);background:var(--code);padding:.12em .35em}
:where(pre){background:var(--subtle);border:1px solid var(--line);padding:14px 16px;overflow:auto;line-height:1.6}
:where(pre code){background:none;padding:0}
:where(blockquote){border-left:2px solid var(--accent);margin-left:0;padding:0 0 0 1.1em;color:var(--muted)}
:where(hr){border:0;border-top:1px solid var(--line);margin:2.5em 0}
:where(table){border-collapse:collapse;width:100%;font-size:.92rem}
:where(th,td){padding:.75em 1em .75em 0;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
:where(th){font:500 .78rem var(--mono);letter-spacing:0;color:var(--muted);border-bottom-color:var(--line-strong)}
:where(button,input,select,textarea){font:inherit;color:inherit}
:where(button){background:var(--fg);color:var(--bg);border:1px solid var(--fg);padding:.5em 1em;font-weight:500;cursor:pointer;transition:opacity .12s}
:where(button:hover){opacity:.85}
:where(button:active){transform:scale(.98)}
:where(button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
:where(input,select,textarea){background:var(--bg);border:1px solid var(--line-strong);padding:.5em .75em}
:where(input[type=checkbox]){accent-color:var(--accent)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const TEMPLATE_CSS = `
.page{max-width:var(--measure);margin:0 auto;padding:clamp(32px,8vw,88px) clamp(20px,5vw,32px) 96px}
.page.wide{max-width:64rem}
.page>header{margin-bottom:2.5rem}
.page>header h1{margin:0 0 .8rem}
.page>header p{margin:0;color:var(--muted);max-width:34rem}
.meta{font:400 .8rem var(--mono);color:var(--muted);margin:0 0 .9rem}
.table-wrap{overflow:auto;max-height:78vh;border-top:1px solid var(--fg);border-bottom:1px solid var(--line-strong)}
.table-wrap table{margin:0;min-width:100%}
.table-wrap th{position:sticky;top:0;background:var(--bg);white-space:nowrap;user-select:none;cursor:pointer}
.table-wrap th:hover{color:var(--fg)}
.table-wrap td,.table-wrap th{padding-right:1.5em}
.table-wrap tbody tr:last-child td{border-bottom:0}
.table-wrap tbody tr:hover td{background:var(--tint)}
td.num,th.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
.tools{display:flex;gap:16px;margin-bottom:12px;align-items:baseline}
.tools input{flex:1;min-width:0;max-width:18rem}
.tools .count{font:400 .8rem var(--mono);color:var(--muted);white-space:nowrap}
.chart-box{position:relative;height:min(56vh,380px);border-top:1px solid var(--fg);padding-top:20px}
details{margin-top:2rem}
summary{cursor:pointer;font:400 .8rem var(--mono);color:var(--muted);list-style:none}
summary::before{content:"▸ "}
details[open] summary::before{content:"▾ "}
summary::-webkit-details-marker{display:none}
.doc :where(h1){margin-bottom:.6em}
.doc :where(img){border:1px solid var(--line)}
.doc :where(table){display:block;overflow:auto}
.doc :where(table) :where(tr:last-child td){border-bottom:0}
.doc input[type=checkbox]{appearance:none;-webkit-appearance:none;width:1em;height:1em;border:1px solid var(--fg);background:var(--bg);vertical-align:-.15em;margin:0 .65em 0 0;opacity:1}
.doc input[type=checkbox]:checked{border-color:var(--accent);background:var(--accent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='white' stroke-width='2'/%3E%3C/svg%3E") center/80% no-repeat}
.doc :where(ul.contains-task-list,ul:has(>li>input[type=checkbox])){list-style:none;padding-left:0}
`;

const meta = (title: string, description: string): string =>
  `<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#c2255c">`;

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
${FONT_LINK}
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
  readonly name: string;
  readonly origin: string;
  readonly token: string;
}

const stripTags = (html: string): string =>
  html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");

const renderMarkdown = (source: string, ctx: Context): string => {
  const html = marked.parse(source, { gfm: true, async: false });
  const title = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const firstParagraph = /<p>([\s\S]*?)<\/p>/i.exec(html)?.[1];
  return shell({
    title: clipToOneLine(stripTags(title ?? ctx.name), MAX_TITLE_CHARS),
    description: clipToOneLine(stripTags(firstParagraph ?? source), MAX_DESCRIPTION_CHARS),
    body: `<article class="doc">${html}</article>`,
  });
};

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
  const isNumericColumn = columns.map(
    (_, i) => rows.length > 0 && rows.every((r) => r[i] == null || typeof r[i] === "number"),
  );
  const head = columns
    .map((c, i) => `<th${isNumericColumn[i] ? ' class="num"' : ""}>${escapeHtml(c)}</th>`)
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${columns
          .map((_, i) => {
            const v = r[i] ?? "";
            return `<td${isNumericColumn[i] ? ' class="num"' : ""} data-v="${escapeHtml(String(v))}">${escapeHtml(typeof v === "number" ? v.toLocaleString("en") : String(v))}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return shell({
    title: clipToOneLine(title, MAX_TITLE_CHARS),
    description: clipToOneLine(
      description ?? `${rows.length} rows, ${columns.length} columns`,
      MAX_DESCRIPTION_CHARS,
    ),
    wide: columns.length > 4,
    body: `<header><h1>${escapeHtml(title)}</h1>${description ? `<p>${escapeHtml(description)}</p>` : ""}</header>
<div class="tools"><input id="q" type="search" placeholder="Filter" aria-label="Filter rows"><span class="count" id="n"></span></div>
<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
<style>th[data-sort]::after{content:" " attr(data-sort);color:var(--fg)}</style>
<script>${TABLE_SCRIPT}</script>`,
  });
};

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
const css=getComputedStyle(document.documentElement);const v=n=>css.getPropertyValue(n).trim();
const fg=v("--fg"),muted=v("--muted"),line=v("--line"),bg=v("--bg");
const palette=[fg,v("--accent"),"#8a8a8a","#e8a33d","#3b82a0","#7a5c8a"];
const round=spec.type==="pie"||spec.type==="doughnut";
const datasets=spec.datasets.map((d,i)=>({label:d.label,data:d.data,
backgroundColor:round?spec.labels.map((_,j)=>palette[j%palette.length]):(spec.type==="radar"?palette[i%palette.length]+"26":palette[i%palette.length]),
borderColor:round?bg:palette[i%palette.length],borderWidth:round?2:1.5,tension:0,borderRadius:0,pointRadius:spec.type==="line"?3:0,pointStyle:"rect",fill:spec.type==="radar"}));
Chart.defaults.color=muted;Chart.defaults.font.family=v("--mono");Chart.defaults.font.size=11;
new Chart(document.getElementById("c"),{type:spec.type,data:{labels:spec.labels,datasets},options:{responsive:true,maintainAspectRatio:false,cutout:spec.type==="doughnut"?"68%":undefined,
plugins:{legend:{display:round||spec.datasets.length>1,position:"bottom",labels:{color:fg,boxWidth:10,boxHeight:10,padding:18}}},
scales:round||spec.type==="radar"?{}:{x:{grid:{display:false},border:{color:v("--line-strong")}},y:{grid:{color:line},border:{display:false},beginAtZero:true}}}});})();`;

const renderChart = (source: string, ctx: Context): string => {
  const spec = decodeChart(source);
  if (Option.isNone(spec)) return renderError("This chart's data is not valid.", ctx);
  const { title = ctx.name, description, labels, datasets } = spec.value;
  const rows = labels
    .map(
      (l, i) =>
        `<tr><td>${escapeHtml(l)}</td>${datasets.map((d) => `<td class="num">${(d.data[i] ?? "").toLocaleString("en")}</td>`).join("")}</tr>`,
    )
    .join("");
  return shell({
    title: clipToOneLine(title, MAX_TITLE_CHARS),
    description: clipToOneLine(
      description ?? datasets.map((d) => d.label).join(", "),
      MAX_DESCRIPTION_CHARS,
    ),
    body: `<header><h1>${escapeHtml(title)}</h1>${description ? `<p>${escapeHtml(description)}</p>` : ""}</header>
<div><div class="chart-box"><canvas id="c" role="img" aria-label="${escapeHtml(title)}"></canvas></div></div>
<details><summary>data</summary>
<div class="table-wrap" style="margin-top:.75rem;max-height:none"><table><thead><tr><th></th>${datasets.map((d) => `<th class="num">${escapeHtml(d.label)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div></details>
<script id="spec" type="application/json">${jsonSafeInScriptTag(spec.value)}</script>
<script src="${CHART_JS}"></script>
<script>${CHART_SCRIPT}</script>`,
  });
};

const readOnlyPageDataBridge = (ctx: Context): string => `<script>
(()=>{const base=${jsonSafeInScriptTag(ctx.origin)}+"/d/"+${jsonSafeInScriptTag(ctx.token)};
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
    FONT_LINK,
    `<style id="mizook-base">${BASE_CSS}:where(body){max-width:var(--measure);margin:0 auto;padding:clamp(32px,8vw,88px) clamp(20px,5vw,24px) 96px}</style>`,
    readOnlyPageDataBridge(ctx),
  ].join("\n");

const renderHtml = (source: string, ctx: Context): string => {
  const title = clipToOneLine(
    stripTags(
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] ??
        /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(source)?.[1] ??
        ctx.name,
    ),
    MAX_TITLE_CHARS,
  );
  const described =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(source)?.[1] ??
    clipToOneLine(
      stripTags(source.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")),
      MAX_DESCRIPTION_CHARS,
    );
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
    body: `<p>${escapeHtml(message)}</p>`,
  });

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

const STYLE_BLOCKS = /<style[^>]*>([\s\S]*?)<\/style>|\sstyle=("[^"]*"|'[^']*')/gi;
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;
const FONT_SIZE_LITERAL = /font-size\s*:\s*[\d.]+(?:px|rem)/i;

const htmlDesignTokenViolation = (source: string): string | undefined => {
  for (const m of source.matchAll(STYLE_BLOCKS)) {
    const css = (m[1] ?? m[2] ?? "").replace(/var\([^)]*\)/g, "");
    if (COLOR_LITERAL.test(css)) {
      return "html pages use the colour variables (var(--fg), var(--muted), var(--accent), var(--accent-soft), var(--tint), var(--line), var(--subtle), var(--code), var(--bg)), not hex, rgb, hsl or oklch values. Rewrite the colours with var().";
    }
    if (FONT_SIZE_LITERAL.test(css)) {
      return "html pages use the size variables for font-size (var(--text-sm), var(--text-base), var(--text-lg), var(--text-xl), var(--text-2xl)), not px or rem values. Rewrite font-size with var().";
    }
    if (
      /font-family\s*:/i.test(css) &&
      !/font-family\s*:\s*var\(--(?:font|mono)\)/i.test(m[1] ?? m[2] ?? "")
    ) {
      return "html pages use font-family: var(--font) or var(--mono) only.";
    }
  }
  return undefined;
};

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
    case "html":
      return htmlDesignTokenViolation(source);
    default:
      return undefined;
  }
};
