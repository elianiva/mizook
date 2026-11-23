import { Duration, Effect } from "effect";

const SERVICE_WORKER_PATH = "/sw.js";
const SERVICE_WORKER_SCOPE = "/c";
const UPDATE_CHECK_INTERVAL = Duration.hours(1);

const watchForUpdates = (registration: ServiceWorkerRegistration): void => {
  let lastUpdateCheck = 0;
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState !== "hidden" ||
      Date.now() - lastUpdateCheck < Duration.toMillis(UPDATE_CHECK_INTERVAL)
    ) {
      return;
    }
    lastUpdateCheck = Date.now();
    // Offline, or the check failed; the next launch checks again.
    Effect.runFork(Effect.tryPromise(() => registration.update()).pipe(Effect.ignore));
  });
};

// The chat works without a service worker; it just cannot open offline.
const registerServiceWorker = Effect.tryPromise(() =>
  navigator.serviceWorker.register(SERVICE_WORKER_PATH, {
    scope: SERVICE_WORKER_SCOPE,
    updateViaCache: "none",
  }),
).pipe(
  Effect.tap((registration) => Effect.sync(() => watchForUpdates(registration))),
  Effect.ignore,
);

export const startServiceWorker = (): void => {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  const register = (): void => {
    Effect.runFork(registerServiceWorker);
  };

  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
};
