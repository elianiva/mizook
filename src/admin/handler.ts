import { Effect } from "effect";
import type { Env } from "../env.ts";
import type { ChannelInfo } from "../host.ts";
import { makeVerifier, type Verifier } from "./access.ts";
import type { LogMessage, Overview, ScheduleRow, UsageReport, ViewLine } from "./read.ts";
import * as pages from "./pages.ts";

interface ChannelRpc {
  dashboard(page: string, params: Record<string, string>): Promise<unknown>;
}

let verifier: { key: string; value: Verifier } | undefined;
const verifierFor = (env: Env): Verifier | undefined => {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return undefined;
  const key = `${env.ACCESS_TEAM_DOMAIN}|${env.ACCESS_AUD}`;
  if (verifier?.key !== key)
    verifier = {
      key,
      value: makeVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }),
    };
  return verifier.value;
};

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });

/**
 * The dashboard, read-only. Every request must carry a token Access signed for this application,
 * checked here as well as at the edge, so a route Access does not cover still stays shut.
 */
export const handleAdmin = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const check = verifierFor(env);
  if (!check) return new Response("The dashboard is not configured", { status: 503 });
  const who = await Effect.runPromise(
    check
      .verify(request.headers.get("cf-access-jwt-assertion"))
      .pipe(Effect.match({ onSuccess: (email) => email, onFailure: () => undefined })),
  );
  if (who === undefined) return new Response("Forbidden", { status: 403 });

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/admin\/?/, "").replace(/\/$/, "");
  const hub = env.Hub.getByName("hub") as unknown as { list(): Promise<ChannelInfo[]> };
  const channels = await hub.list();
  if (channels.length === 0) return html("<p>No channel has been used yet.</p>");
  const wanted = url.searchParams.get("c") ?? "";
  const channel = channels.find((c) => c.doName === wanted)?.doName ?? channels[0]!.doName;
  const rpc = env.ChatAgent.getByName(channel) as unknown as ChannelRpc;
  const ask = <T>(page: string, params: Record<string, string> = {}) =>
    rpc.dashboard(page, params) as Promise<T>;
  const params = Object.fromEntries(url.searchParams);
  const ctx = { email: who, channel, channels, path: path === "message" ? "messages" : path };
  const page = (title: string, body: string) => html(pages.layout(title, body, ctx));

  switch (path) {
    case "": {
      const o = await ask<Overview>("overview");
      return page("Status", pages.statusPage(o, Number(o.settings.budget) || 0));
    }
    case "messages":
      return page(
        "Log",
        pages.logPage(await ask<LogMessage[]>("messages", params), {
          channel,
          kind: params.kind ?? "",
          q: params.q ?? "",
        }),
      );
    case "message": {
      const m = await ask<Parameters<typeof pages.messagePage>[0] | undefined>("message", params);
      return m
        ? page(`Message ${m.i}`, pages.messagePage(m))
        : new Response("Not found", { status: 404 });
    }
    case "memory":
      return page("Memory", pages.memoryPage(await ask<ViewLine[]>("memory")));
    case "usage": {
      const days = Math.min(Math.max(Number(params.days) || 30, 1), 365);
      return page(
        "Usage",
        pages.usagePage(await ask<UsageReport>("usage", { days: String(days) }), days),
      );
    }
    case "schedules":
      return page("Schedules", pages.schedulesPage(await ask<ScheduleRow[]>("schedules")));
    default:
      return new Response("Not found", { status: 404 });
  }
};
