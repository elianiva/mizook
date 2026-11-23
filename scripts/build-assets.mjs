import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const dist = `${root}dist`;
const web = `${root}apps/web/dist`;
const dashboard = `${root}apps/dashboard/dist`;

const missing = [
  [`${web}/index.html`, "apps/web/dist/index.html is missing; build @mizook/web first"],
  [
    `${dashboard}/index.html`,
    "apps/dashboard/dist/index.html is missing; build @mizook/dashboard first",
  ],
].find(([path]) => !existsSync(path));

if (missing !== undefined) {
  console.error(missing[1]);
  process.exitCode = 1;
} else {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await cp(web, dist, { recursive: true });
  await cp(dashboard, `${dist}/admin`, { recursive: true });

  console.log("assets: dist/ (chat) and dist/admin/ (dashboard)");
}
