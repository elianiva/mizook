const SERVICE_WORKER_PATH = "/sw.js";
const SERVICE_WORKER_SCOPE = "/c";
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export const startServiceWorker = (): void => {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  const register = (): void => {
    void navigator.serviceWorker
      .register(SERVICE_WORKER_PATH, {
        scope: SERVICE_WORKER_SCOPE,
        updateViaCache: "none",
      })
      .then((registration) => {
        let lastUpdateCheck = 0;
        document.addEventListener("visibilitychange", () => {
          if (
            document.visibilityState !== "hidden" ||
            Date.now() - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS
          ) {
            return;
          }
          lastUpdateCheck = Date.now();
          void registration.update().catch(() => {
            // Offline, or the check failed; the next launch checks again.
          });
        });
      })
      .catch(() => {
        // The chat works without a service worker; it just cannot open offline.
      });
  };

  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
};
