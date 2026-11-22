import { foldkit } from "@foldkit/vite-plugin";
import pandacss from "@pandacss/vite";
import { defineConfig } from "vite";

const WORKER_SERVES_DASHBOARD_AT = "/admin/";
const WORKER_ADMIN_API_PATH = "/admin/api";
const LOCAL_WORKER_URL = "http://localhost:8788";

export default defineConfig({
  base: WORKER_SERVES_DASHBOARD_AT,
  plugins: [pandacss(), foldkit()],
  optimizeDeps: { entries: ["src/entry.ts"] },
  resolve: { dedupe: ["effect", "foldkit"] },
  server: {
    ...(process.env["VITE_ALLOWED_HOSTS"] !== undefined && { allowedHosts: true as const }),
    proxy: { [WORKER_ADMIN_API_PATH]: process.env["ADMIN_API"] ?? LOCAL_WORKER_URL },
  },
});
