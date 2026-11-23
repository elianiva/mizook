import { foldkit } from "@foldkit/vite-plugin";
import pandacss from "@pandacss/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const WORKER_API_PATH = "/c/api";
const LOCAL_WORKER_URL = "http://localhost:8788";
const APP_SCOPE = "/c";

export default defineConfig({
  base: "/",
  plugins: [
    pandacss(),
    foldkit(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      scope: APP_SCOPE,
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,woff,woff2}"],
        globIgnores: ["**/sw.js"],
        rollupFormat: "iife",
      },
    }),
  ],
  optimizeDeps: { entries: ["src/entry.ts"] },
  resolve: { dedupe: ["effect", "foldkit"] },
  server: {
    ...(process.env["VITE_ALLOWED_HOSTS"] !== undefined && { allowedHosts: true as const }),
    proxy: { [WORKER_API_PATH]: process.env["CHAT_API"] ?? LOCAL_WORKER_URL },
  },
});
