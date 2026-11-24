import { createHighlightsPlugin } from "@pierre/words/highlights";
import { createHtmlRenderer } from "@pierre/words/html";
import dark from "@pierre/highlights/themes/pierre-dark";
import light from "@pierre/highlights/themes/pierre-light";
import { safeHref } from "./markdown.ts";

const plugins = {
  code: createHighlightsPlugin({ themes: { light, dark }, defaultColor: "light-dark()" }),
};

// Raw HTML is omitted by Words itself. Links keep http, https and mailto; images keep https.
const urlTransform = (url: string, key: "href" | "src"): string | undefined =>
  safeHref(url, key === "src");

/** Options shared by the HTML and DOM renderers. */
export const domOptions = { plugins, lineNumbers: false, urlTransform };

const CACHE_LIMIT = 300;
const finished = new Map<string, string>();

/**
 * Markdown to HTML with syntax-highlighted code. A source still arriving is
 * rendered with its unfinished syntax completed; a finished one is cached.
 */
export const renderWords = (source: string, streaming: boolean): string => {
  const cached = streaming ? undefined : finished.get(source);
  if (cached !== undefined) return cached;
  const renderer = createHtmlRenderer({
    plugins,
    controls: false,
    lineNumbers: false,
    urlTransform,
  });
  try {
    const html = renderer.render(source, streaming, streaming).html as string;
    if (!streaming) {
      if (finished.size >= CACHE_LIMIT) finished.clear();
      finished.set(source, html);
    }
    return html;
  } finally {
    renderer.dispose();
  }
};
