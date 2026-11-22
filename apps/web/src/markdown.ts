import { Marked, Renderer } from "marked";

const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ENTITIES[char]!);

const safeHref = (href: string, image: boolean): string | undefined => {
  try {
    const url = new URL(href);
    if (image) return url.protocol === "https:" ? href : undefined;
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:"
      ? href
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Raw HTML in a model answer is text, never markup. Links keep only http,
 * https and mailto; images keep only https. Web content the agent quotes is
 * untrusted, so nothing here may run.
 */
const safeRenderer = new Renderer();
safeRenderer.html = ({ text }) => escapeHtml(text);
safeRenderer.link = function (this: Renderer, { href, title, tokens }) {
  const safe = safeHref(href, false);
  const inner = this.parser.parseInline(tokens);
  if (safe === undefined) return inner;
  const titleAttribute =
    title === null || title === undefined ? "" : ` title="${escapeHtml(title)}"`;
  return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer"${titleAttribute}>${inner}</a>`;
};
safeRenderer.image = function (this: Renderer, { href, title, text, tokens }) {
  const safe = safeHref(href, true);
  if (safe === undefined) {
    const alt =
      tokens === undefined ? text : this.parser.parseInline(tokens, this.parser.textRenderer);
    return escapeHtml(alt);
  }
  const titleAttribute =
    title === null || title === undefined ? "" : ` title="${escapeHtml(title)}"`;
  return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text)}"${titleAttribute} loading="lazy" />`;
};

const marked = new Marked({ gfm: true, breaks: true, renderer: safeRenderer });

export const renderMarkdown = (text: string): string => marked.parse(text) as string;
