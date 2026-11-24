import { expect, test, vi } from "vite-plus/test";
import type { Env } from "../src/env.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, RpcTarget: class {} }));

const { default: worker } = await import("../src/worker.ts");

// The asset layer redirects /index.html to the root. A page route that passes
// that redirect on sends the browser to /, which sends it back to /c.
const assets = {
  fetch: async (request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/index.html") {
      return new Response(null, { status: 307, headers: { location: "/" } });
    }
    if (pathname === "/") {
      return new Response("<html>shell</html>", { headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  },
};

test("a page route serves the shell instead of passing on the asset redirect", async () => {
  const env = { ASSETS: assets } as unknown as Env;
  const response = await worker.fetch(new Request("https://mzk.test/c"), env);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("<html>shell</html>");
});
