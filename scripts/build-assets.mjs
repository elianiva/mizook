import { cp, mkdir, rm, stat } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const dist = `${root}dist`;
const web = `${root}apps/web/dist`;
const dashboard = `${root}apps/dashboard/dist`;

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(`${web}/index.html`))) {
  throw new Error("apps/web/dist/index.html is missing; build @mizook/web first");
}
if (!(await exists(`${dashboard}/index.html`))) {
  throw new Error("apps/dashboard/dist/index.html is missing; build @mizook/dashboard first");
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(web, dist, { recursive: true });
await cp(dashboard, `${dist}/admin`, { recursive: true });

console.log("assets: dist/ (chat) and dist/admin/ (dashboard)");
