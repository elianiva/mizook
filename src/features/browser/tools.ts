import { Effect } from "effect";
import { tool } from "ai";
import { z } from "zod";
import puppeteer from "@cloudflare/puppeteer";
import type { MizookAgent } from "../../core/agent";
import type { ChatTarget } from "../../core/channel";
import type { Env } from "../../core/env";
import { ChannelRegistry } from "../../core/channel-registry";

async function takeScreenshot(
  env: Env,
  url: string,
  options?: {
    fullPage?: boolean;
    width?: number;
    height?: number;
    waitUntil?: "load" | "networkidle0" | "networkidle2" | "domcontentloaded";
    selector?: string;
  },
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const browser = await puppeteer.launch(env.BROWSER as unknown as Fetcher);
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
          : ((await page.screenshot({
              fullPage: options?.fullPage ?? false,
              encoding: "base64",
            })) as string);

        if (!b64) throw new Error(`Screenshot of ${url} returned empty result`);
        return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      } finally {
        try {
          await browser.close();
        } catch {
          // Cleanup — swallow close errors to preserve original failure
        }
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function storeAndSend(
  env: Env,
  agent: MizookAgent,
  img: Uint8Array,
  target: ChatTarget,
  url: string,
  caption?: string,
) {
  const key = `screenshots/${crypto.randomUUID()}.png`;
  await env.MIZOOK_R2.put(key, img, { httpMetadata: { contentType: "image/png" } });
  await agent.run(
    ChannelRegistry.use((r) =>
      r
        .get(target.platform)
        .pipe(Effect.flatMap((ch) => ch.postPhoto(target, img, caption ?? `Screenshot of ${url}`))),
    ),
  );
  return key;
}

export function createBrowserTools(agent: MizookAgent) {
  const env = agent.appEnv;
  const getTarget = (): ChatTarget | null => {
    const turn = agent.getTurnState();
    return turn ? { platform: turn.channelType, chatId: turn.chatId } : null;
  };

  return {
    browser_screenshot_and_send: tool({
      description:
        "Take a screenshot of a URL and send it directly to the current chat. " +
        "One-step: captures, saves, and sends in a single call. " +
        "Use this when the user asks you to screenshot a page and send it to them.",
      inputSchema: z.object({
        url: z.string().url().describe("The URL to screenshot"),
        caption: z.string().optional().describe("Optional caption for the image"),
        fullPage: z.boolean().optional().describe("Capture full scrollable page"),
        width: z.number().optional().describe("Viewport width (default: 1280)"),
        height: z.number().optional().describe("Viewport height (default: 720)"),
        waitUntil: z.enum(["load", "networkidle0", "networkidle2", "domcontentloaded"]).optional(),
      }),
      execute: async (params) => {
        const target = getTarget();
        if (!target) return "No active chat to send to.";
        const img = await takeScreenshot(env, params.url, params);
        const key = await storeAndSend(env, agent, img, target, params.url, params.caption);
        return `Screenshot of ${params.url} captured and sent. R2 key: ${key}`;
      },
    }),
  };
}
