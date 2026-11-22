import { foldkit } from "@foldkit/vite-plugin";
import pandacss from "@pandacss/vite";
import { defineConfig } from "vite";

const WORKER_API_PATH = "/c/api";
const LOCAL_WORKER_URL = "http://localhost:8788";

export default defineConfig({
  base: "/",
  plugins: [pandacss(), foldkit()],
  optimizeDeps: { entries: ["src/entry.ts"] },
  resolve: { dedupe: ["effect", "foldkit"] },
  server: {
    ...(process.env["VITE_ALLOWED_HOSTS"] !== undefined && { allowedHosts: true as const }),
    proxy: { [WORKER_API_PATH]: process.env["CHAT_API"] ?? LOCAL_WORKER_URL },
  },
});
