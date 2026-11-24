import { clipToolOutput } from "@mizook/memory";
import { Effect, Schema } from "effect";
import { Artifacts } from "./artifacts.ts";
import { Blobs } from "./blobs.ts";
import { Browser } from "./browser.ts";
import { ToolError } from "./errors.ts";
import { Self } from "./host.ts";
import { MEDIA_LABEL, Media } from "./media.ts";
import { Web } from "./search.ts";
import { defineTool, described } from "./tool.ts";

export const FileReadArgs = Schema.Struct({
  key: described(Schema.String, "The key from an [attached …] note in a message."),
});

export const WebSearchArgs = Schema.Struct({
  query: described(Schema.String, "What to search for, as keywords or a short question."),
});

export const WebFetchArgs = Schema.Struct({
  url: described(Schema.String, "The http(s) URL to read."),
});

export const BrowserReadArgs = Schema.Struct({
  url: described(Schema.String, "The public http(s) page to render."),
});

export const fileTools = [
  defineTool({
    name: "file_read",
    path: "files.read",
    description:
      "Read a file the user attached. Text, markdown, JSON, CSV and code are read directly. Voice notes are transcribed, images are described, and PDF or Office files are converted. Other binary files come back as a size and type only.",
    args: FileReadArgs,
    run: (a) =>
      Effect.gen(function* () {
        if (!a.key.startsWith("inbox/")) {
          return yield* new ToolError({ reason: "only attached files can be read" });
        }
        const blob = yield* (yield* Blobs).get(a.key);
        if (!blob) return yield* new ToolError({ reason: `no file ${a.key}` });
        const textual = /^(text\/|application\/(json|xml|x-yaml|javascript))/.test(
          blob.contentType,
        );
        if (textual) return clipToolOutput(new TextDecoder().decode(blob.body));
        const extracted = yield* (yield* Media)
          .extract({
            bytes: blob.body,
            contentType: blob.contentType,
            name: a.key.split("/").at(-1) ?? a.key,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(`media ${a.key} failed: ${error.message}`).pipe(
                Effect.as(undefined),
              ),
            ),
          );
        return extracted === undefined
          ? `Binary file: ${blob.contentType}, ${blob.body.length} bytes. I cannot read its content.`
          : `${MEDIA_LABEL[extracted.kind]}:\n${clipToolOutput(extracted.text, 16_000)}`;
      }),
  }),
];

export const webTools = [
  defineTool({
    name: "web_search",
    path: "web.search",
    description: "Search the web. Returns titles, URLs and excerpts.",
    args: WebSearchArgs,
    run: (a) => Web.use((web) => web.search(a.query)),
  }),
  defineTool({
    name: "web_fetch",
    path: "web.fetch",
    description: "Read a web page as plain text.",
    args: WebFetchArgs,
    run: (a) =>
      Web.use((web) =>
        Effect.map(
          web.fetch(a.url),
          (page) =>
            `${page.status} ${page.contentType}${page.truncated ? " (cut)" : ""}\n${clipToolOutput(page.text)}`,
        ),
      ),
  }),
  defineTool({
    name: "browser_read",
    path: "web.render",
    description:
      "Render a public page that plain fetch cannot read, such as a site built with JavaScript. Returns the page as markdown and a screenshot link. Use web.fetch first when the page is simple.",
    args: BrowserReadArgs,
    run: (a) =>
      Effect.gen(function* () {
        const page = yield* (yield* Browser).read(a.url);
        const body =
          page.text === ""
            ? "The page loaded but had no readable text."
            : clipToolOutput(page.text, 20_000);
        const heading = page.title ? `${page.title}\n\n` : "";
        if (!page.screenshot) return `${heading}${body}`;
        const self = yield* Self;
        const shot = yield* (yield* Artifacts)
          .publishBytes(self.doName, `browser-${Date.now()}`, page.screenshot, "image/png")
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(`browser screenshot failed: ${error.message}`).pipe(
                Effect.as(undefined),
              ),
            ),
          );
        return `${heading}${body}${shot ? `\n\nScreenshot: ${shot.url}` : ""}`;
      }),
  }),
];
