/** Telegram refuses a message over 4096 characters. */
const LIMIT = 4000;

/** Split a reply at paragraph, line, or word breaks so no part is over `LIMIT`. */
export const chunk = (text: string, limit = LIMIT): string[] => {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    const at = cut > limit / 2 ? cut : limit;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest !== "") parts.push(rest);
  return parts;
};
