import { tool } from "ai";
import { z } from "zod";
import puppeteer from "@cloudflare/puppeteer";
import { createScopedLogger } from "../logger";

interface BrowserEnv {
  BROWSER: Fetcher;
  SCREENSHOTS: R2Bucket;
  BOT_TOKEN?: string;
}

export type ChatTarget = { platform: "telegram"; chatId: number } | { platform: "unknown" };

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
    await page.setViewport({
      width: options?.width ?? 1280,
      height: options?.height ?? 720,
    });
    await page.goto(url, {
      waitUntil: options?.waitUntil ?? "networkidle0",
    });

    const b64 = options?.selector
      ? await (async () => {
          const el = await page.$(options.selector!);
          if (!el) throw new Error(`Selector "${options.selector}" not found`);
          const box = await el.boundingBox();
          if (!box) throw new Error("Element has no bounding box");
          const result = await page.screenshot({
            clip: { x: box.x, y: box.y, width: box.width, height: box.height },
            encoding: "base64",
          });
          return result as string;
        })()
      : ((await page.screenshot({
          fullPage: options?.fullPage ?? false,
          encoding: "base64",
        })) as string);

    if (!b64) throw new Error(`Screenshot of ${url} returned empty result`);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } finally {
    await browser.close().catch((err) => {
      createScopedLogger({ action: "browser_close_error" }).error(err);
    });
  }
}

async function uploadScreenshot(env: BrowserEnv, img: Uint8Array, target: ChatTarget) {
  const platform = target.platform === "unknown" ? "unknown" : target.platform;
  const id = target.platform === "telegram" ? String(target.chatId) : "unknown";
  const key = `screenshots/${platform}/${id}/${Date.now()}.png`;
  await env.SCREENSHOTS.put(key, img, {
    httpMetadata: { contentType: "image/png" },
  });
  return key;
}

export function createBrowserTools(env: BrowserEnv, getTarget: () => ChatTarget) {
  return {
    browser_screenshot: tool({
      description:
        "Take a screenshot of a URL using a headless browser. " +
        "Screenshot is saved to R2. Use this when the user asks you to 'look at' a " +
        "website or check how a page looks. Returns an R2 key you can pass to " +
        "send_photo_to_chat to send the image to the user.",
      inputSchema: z.object({
        url: z.string().url().describe("The URL to take a screenshot of"),
        fullPage: z
          .boolean()
          .optional()
          .describe("Capture full scrollable page, not just viewport"),
        width: z.number().optional().describe("Viewport width (default: 1280)"),
        height: z.number().optional().describe("Viewport height (default: 720)"),
        waitUntil: z
          .enum(["load", "networkidle0", "networkidle2", "domcontentloaded"])
          .optional()
          .describe("When to consider navigation complete"),
        selector: z.string().optional().describe("CSS selector to capture a specific element only"),
      }),
      execute: async (params) => {
        const target = getTarget();
        const img = await takeScreenshot(env, params.url, params);
        const key = await uploadScreenshot(env, img, target);
        return `Screenshot taken of ${params.url}. R2 key: ${key}. Use send_photo_to_chat with this key to send it to the user.`;
      },
    }),

    browser_screenshot_and_send: tool({
      description:
        "Take a screenshot of a URL and send it directly to the user as a photo. " +
        "Use this when the user says 'go to X and send me the screenshot'. " +
        "One-step: captures, saves, and sends to the current chat.",
      inputSchema: z.object({
        url: z.string().url().describe("The URL to take a screenshot of"),
        caption: z.string().optional().describe("Optional caption for the image"),
        fullPage: z.boolean().optional().describe("Capture full scrollable page"),
      }),
      execute: async ({ url, caption, fullPage }) => {
        const target = getTarget();
        const img = await takeScreenshot(env, url, { fullPage });
        const key = await uploadScreenshot(env, img, target);
        await sendPhotoToChat(env, target, img, caption ?? `Screenshot of ${url}`);
        return `Took screenshot of ${url} and sent it to the chat. R2 key: ${key}`;
      },
    }),

    send_photo_to_chat: tool({
      description:
        "Send a screenshot (by its R2 key) to the current chat as a photo. " +
        "Use this when browser_screenshot returned a key and you want to share " +
        "the image with the user.",
      inputSchema: z.object({
        r2Key: z.string().describe("The R2 key returned by browser_screenshot"),
        caption: z.string().optional().describe("Optional caption"),
      }),
      execute: async ({ r2Key, caption }) => {
        const target = getTarget();
        const obj = await env.SCREENSHOTS.get(r2Key);
        if (!obj) return "Screenshot not found or expired.";
        const buf = new Uint8Array(await obj.arrayBuffer());
        await sendPhotoToChat(env, target, buf, caption ?? "Screenshot");
        return "Sent screenshot to chat.";
      },
    }),
  };
}

async function sendPhotoToChat(
  env: BrowserEnv,
  target: ChatTarget,
  image: Uint8Array,
  caption: string,
) {
  const safeCaption = caption.slice(0, 200);

  if (target.platform === "telegram" && env.BOT_TOKEN) {
    const form = new FormData();
    form.append("chat_id", String(target.chatId));
    form.append("photo", new Blob([image as BlobPart], { type: "image/png" }), "screenshot.png");
    form.append("caption", safeCaption);
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      body: form,
    });
  }
}
