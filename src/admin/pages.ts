import type { ChannelInfo } from "../host.ts";
import type { LogMessage, Overview, ScheduleRow, UsageReport, ViewLine } from "./read.ts";

export const esc = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

const CSS = `body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#fafafa;color:#222}
nav{display:flex;gap:1rem;align-items:center;padding:.6rem 1rem;background:#fff;border-bottom:1px solid #ddd;flex-wrap:wrap}
nav a{color:#06c;text-decoration:none}nav a.on{font-weight:700;color:#222}nav .who{margin-left:auto;color:#777;font-size:13px}
main{max-width:60rem;margin:1rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}
td,th{padding:.3rem .5rem;border-bottom:1px solid #e5e5e5;text-align:left;vertical-align:top}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font:13px/1.4 ui-monospace,monospace}
.k{display:inline-block;padding:0 .4rem;border-radius:4px;background:#eee;font-size:12px}
.card{background:#fff;border:1px solid #ddd;border-radius:6px;padding:.6rem 1rem;margin:.5rem 0}
.bar{background:#9bc;height:.8rem}input,select,button{font:inherit}`;

const PAGES = [
  ["", "Status"],
  ["messages", "Log"],
  ["memory", "Memory"],
  ["usage", "Usage"],
  ["schedules", "Schedules"],
] as const;

export const layout = (
  title: string,
  body: string,
  ctx: { email: string; channel: string; channels: ReadonlyArray<ChannelInfo>; path: string },
): string => {
  const q = (c: string) => `?c=${encodeURIComponent(c)}`;
  const links = PAGES.map(
    ([p, name]) =>
      `<a class="${ctx.path === p ? "on" : ""}" href="/admin${p ? `/${p}` : ""}${q(ctx.channel)}">${name}</a>`,
  ).join("");
  const select = `<form method="get" action="/admin${ctx.path ? `/${ctx.path}` : ""}"><select name="c" onchange="this.form.submit()">${ctx.channels
    .map(
      (c) =>
        `<option value="${esc(c.doName)}"${c.doName === ctx.channel ? " selected" : ""}>${esc(c.name)}</option>`,
    )
    .join("")}</select></form>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Mizook</title><style>${CSS}</style>
<nav>${select}${links}<span class="who">${esc(ctx.email)}</span></nav><main><h1>${esc(title)}</h1>${body}</main>`;
};

export const statusPage = (o: Overview, budget: number): string => {
  const settings = Object.entries(o.settings);
  return `<div class="card">Messages <b>${o.messages}</b> · nodes <b>${o.nodes}</b> · view lines <b>${o.viewLines}</b> · schedules <b>${o.schedules}</b></div>
<div class="card">Spend: ${usd(o.spend.last24h)} in 24 h${budget > 0 ? ` of ${usd(budget)} budget (${Math.round((o.spend.last24h / budget) * 100)}%)` : ""} · ${usd(o.spend.last7d)} in 7 d · ${usd(o.spend.total)} in all</div>
<h2>Pending turns</h2>${o.turns.length === 0 ? "<p>None.</p>" : `<table>${o.turns.map((t) => `<tr><td>${esc(t.chatId)}</td><td><pre>${esc(t.text)}</pre></td></tr>`).join("")}</table>`}
<h2>Approvals waiting</h2>${o.approvals.length === 0 ? "<p>None.</p>" : `<table>${o.approvals.map((a) => `<tr><td>#${a.id}</td><td><pre>${esc(a.summary)}</pre></td></tr>`).join("")}</table>`}
<h2>Channel settings</h2>${settings.length === 0 ? "<p>All defaults.</p>" : `<table>${settings.map(([k, v]) => `<tr><td>${esc(k)}</td><td><pre>${esc(v)}</pre></td></tr>`).join("")}</table>`}`;
};

export const logPage = (
  list: ReadonlyArray<LogMessage>,
  f: { channel: string; kind: string; q: string },
): string => {
  const last = list.at(-1);
  const base = `?c=${encodeURIComponent(f.channel)}&kind=${encodeURIComponent(f.kind)}&q=${encodeURIComponent(f.q)}`;
  return `<form method="get"><input type="hidden" name="c" value="${esc(f.channel)}">
<select name="kind"><option value="">all kinds</option>${["user", "agent", "tool", "echo", "note"].map((k) => `<option${k === f.kind ? " selected" : ""}>${k}</option>`).join("")}</select>
<input name="q" value="${esc(f.q)}" placeholder="search text"> <button>Filter</button></form>
<table>${list.map((m) => `<tr><td><a href="/admin/message${base}&i=${m.i}">${m.i}</a></td><td><span class="k">${esc(m.kind)}</span></td><td><pre>${esc(m.text)}${m.cut ? " …" : ""}</pre></td><td>${esc(m.date.slice(0, 16).replace("T", " "))}</td></tr>`).join("")}</table>
${last && list.length >= 50 ? `<p><a href="/admin/messages${base}&before=${last.i}">Older</a></p>` : ""}`;
};

export const messagePage = (m: {
  i: number;
  kind: string;
  text: string;
  size: number;
  date: string;
}) =>
  `<p><span class="k">${esc(m.kind)}</span> ${esc(m.date)} · ${m.size} bytes</p><div class="card"><pre>${esc(m.text)}</pre></div>`;

export const memoryPage = (lines: ReadonlyArray<ViewLine>): string =>
  lines.length === 0
    ? "<p>The view is empty.</p>"
    : `<p>${lines.length} lines, ${lines.reduce((n, l) => n + l.size, 0)} bytes of summaries. A line named <code>id+n</code> covers n messages from id; the agent zooms into it.</p>
<table>${lines.map((l) => `<tr><td><code>${esc(l.label)}</code></td><td>L${l.level}</td><td>${esc(l.text)}</td></tr>`).join("")}</table>`;

export const usagePage = (r: UsageReport, days: number): string => {
  const max = Math.max(...r.byDay.map((d) => d.cost), 1e-9);
  return `<p>Last ${days} days. <a href="?days=7">7</a> · <a href="?days=30">30</a> · <a href="?days=90">90</a></p>
<h2>By day</h2><table>${r.byDay.map((d) => `<tr><td>${d.day}</td><td>${usd(d.cost)}</td><td>${d.calls} calls</td><td style="width:50%"><div class="bar" style="width:${Math.round((d.cost / max) * 100)}%"></div></td></tr>`).join("")}</table>
<h2>By model</h2><table><tr><th>Model</th><th>Cost</th><th>Calls</th><th>In</th><th>Out</th><th>Cache hit</th></tr>${r.byModel.map((m) => `<tr><td>${esc(m.model)}</td><td>${usd(m.cost)}</td><td>${m.calls}</td><td>${m.input}</td><td>${m.output}</td><td>${m.input + m.cacheRead > 0 ? Math.round((m.cacheRead / (m.input + m.cacheRead)) * 100) : 0}%</td></tr>`).join("")}</table>
<h2>By kind</h2><table>${r.byKind.map((k) => `<tr><td>${esc(k.kind)}</td><td>${usd(k.cost)}</td><td>${k.calls} calls</td></tr>`).join("")}</table>`;
};

export const schedulesPage = (list: ReadonlyArray<ScheduleRow>): string =>
  list.length === 0
    ? "<p>No active schedules.</p>"
    : `<table>${list.map((s) => `<tr><td>#${s.id}</td><td><code>${esc(s.spec)}</code></td><td>${new Date(s.nextAt).toISOString().slice(0, 16).replace("T", " ")} UTC</td><td><pre>${esc(s.prompt)}</pre></td></tr>`).join("")}</table>`;
