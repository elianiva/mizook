/// <reference lib="webworker" />

import { Effect } from "effect";
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope;

const APP_PATH = "/c";
const MEDIA_PATH = "/c/media/";
const OFFLINE_SHELL = "/index.html";

const isAppNavigation = ({ request, url }: { request: Request; url: URL }): boolean =>
  request.mode === "navigate" &&
  !url.pathname.startsWith(MEDIA_PATH) &&
  (url.pathname === APP_PATH || url.pathname.startsWith(`${APP_PATH}/`));

const shellWhenOffline = async (): Promise<Response> =>
  (await matchPrecache(OFFLINE_SHELL)) ?? Response.error();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// The page is fetched first so Cloudflare Access can renew a session and a new
// shell arrives at once. A followed redirect is handed back to the browser, so
// the Access sign-in page keeps its own address and cookies. Only a failed
// network fetch falls back to the precached shell.
registerRoute(isAppNavigation, ({ request }) =>
  Effect.runPromise(
    Effect.tryPromise(() => fetch(request)).pipe(
      Effect.map((response) =>
        response.redirected ? Response.redirect(response.url, 302) : response,
      ),
      Effect.catch(() => Effect.promise(shellWhenOffline)),
    ),
  ),
);

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
