import { foldkit } from "@foldkit/vite-plugin";
import pandacss from "@pandacss/vite";
import { defineConfig } from "vite";

/** The dashboard is served by the Worker at /admin; its API is the Worker's /admin/api. */
export default defineConfig({
  base: "/admin/",
  plugins: [pandacss(), foldkit()],
  optimizeDeps: { entries: ["src/entry.ts"] },
  server: {
    ...(process.env["VITE_ALLOWED_HOSTS"] !== undefined && { allowedHosts: true as const }),
    proxy: { "/admin/api": process.env["ADMIN_API"] ?? "http://localhost:8788" },
  },
});
