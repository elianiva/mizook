import { tool } from "ai";
import { z } from "zod";
import puppeteer from "@cloudflare/puppeteer";
import type { ChannelInterface } from "../../core/channel";
import { createScopedLogger } from "../../core/logger";

interface BrowserEnv {
  BROWSER: Fetcher;
  SCREENSHOTS: R2Bucket;
}

async function takeScreenshot(
  env: BrowserEnv,
  url: string,
  options?: {
    fullPage?: boolean;
    width?: number;
    height?: number;
    waitUntil?: "load" | "networkidle0" | "networkidle2" | "domcontentloaded";
    selector?: string;
  },
) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: options?.width ?? 1280, height: options?.height ?? 720 });
    await page.goto(url, { waitUntil: options?.waitUntil ?? "networkidle0" });

    const b64 = options?.selector
      ? await (async () => {
          const el = await page.$(options.selector!);
          if (!el) throw new Error(`Selector "${options.selector}" not found`);
          const box = await el.boundingBox();
          if (!box) throw new Error("Element has no bounding box");
          return (await page.screenshot({
            clip: { x: box.x, y: box.y, width: box.width, height: box.height },
            encoding: "base64",
          })) as string;
        })()
      : ((await page.screenshot({ fullPage: options?.fullPage ?? false, encoding: "base64" })) as string);

    if (!b64) throw new Error(`Screenshot of ${url} returned empty result`);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } finally {
    await browser.close().catch((err) => {
      createScopedLogger({ action: "browser_close_error" }).error(err);
    });
  }
}

export function createBrowserTools(
  env: BrowserEnv,
  channel: ChannelInterface,
  getTarget: () => { platform: string; chatId: string } | null,
) {
  return {
    browser_screenshot: tool({
      description:
        "Take a screenshot of a URL using a headless browser. " +
        "Screenshot is saved to R2. Use send_photo with the returned R2 key to send it. " +
        "Use this when the user asks you to visit a website or check how a page looks.",
      inputSchema: z.object({
        url: z.string().url().describe("The URL to screenshot"),
        fullPage: z.boolean().optional().describe("Capture full scrollable page"),
        width: z.number().optional().describe("Viewport width (default: 1280)"),
        height: z.number().optional().describe("Viewport height (default: 720)"),
        waitUntil: z.enum(["load", "networkidle0", "networkidle2", "domcontentloaded"]).optional(),
        selector: z.string().optional().describe("CSS selector to capture a specific element"),
      }),
      execute: async (params) => {
        const target = getTarget();
        const platform = target?.platform ?? "unknown";
        const id = target?.chatId ?? "unknown";

        const img = await takeScreenshot(env, params.url, params);
        const key = `screenshots/${platform}/${id}/${Date.now()}.png`;
        await env.SCREENSHOTS.put(key, img, { httpMetadata: { contentType: "image/png" } });
        return `Screenshot taken of ${params.url}. R2 key: ${key}. Use send_photo with this key to send it.`;
      },
    }),

    send_photo: tool({
      description:
        "Send a screenshot (by its R2 key) to the current chat as a photo. " +
        "Use this after browser_screenshot to share the image with the user.",
      inputSchema: z.object({
        r2Key: z.string().describe("The R2 key returned by browser_screenshot"),
        caption: z.string().optional().describe("Optional caption"),
      }),
      execute: async ({ r2Key, caption }) => {
        const target = getTarget();
        if (!target) return "No active chat to send to.";
        const obj = await env.SCREENSHOTS.get(r2Key);
        if (!obj) return "Screenshot not found or expired.";
        const buf = new Uint8Array(await obj.arrayBuffer());
        await channel.postPhoto(target, buf, caption ?? "Screenshot");
        return "Sent screenshot to chat.";
      },
    }),
  };
}
