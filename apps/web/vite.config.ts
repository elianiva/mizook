import { foldkit } from "@foldkit/vite-plugin";
import pandacss from "@pandacss/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const WORKER_SYNC_PATH = "/c/sync";
const WORKER_UPLOAD_PATH = "/c/upload";
const WORKER_MEDIA_PATH = "/c/media";
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
        // The chat bundles Foldkit, Effect and the highlighter into one entry,
        // which is just over Workbox's 2 MiB default. Offline needs that file.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        rollupFormat: "iife",
      },
    }),
  ],
  optimizeDeps: { entries: ["src/entry.ts"] },
  resolve: { dedupe: ["effect", "foldkit"] },
  server: {
    ...(process.env["VITE_ALLOWED_HOSTS"] !== undefined && { allowedHosts: true as const }),
    proxy: {
      [WORKER_SYNC_PATH]: {
        target: process.env["CHAT_API"] ?? LOCAL_WORKER_URL,
        ws: true,
        changeOrigin: true,
      },
      [WORKER_UPLOAD_PATH]: {
        target: process.env["CHAT_API"] ?? LOCAL_WORKER_URL,
        changeOrigin: true,
      },
      [WORKER_MEDIA_PATH]: {
        target: process.env["CHAT_API"] ?? LOCAL_WORKER_URL,
        changeOrigin: true,
      },
    },
  },
});
