// Telegram MarkdownV2 escaping.
// Characters that must be escaped:
// _ * [ ] ( ) ~ ` > # + - = | { } . !
const MARKDOWN_RE = /([_*[\]()~`>#+=|{}.!-])/g;

/** Escape Telegram MarkdownV2 special characters. */
export const escapeMarkdownV2 = (text: string): string => text.replace(MARKDOWN_RE, "\\$1");

/** Wrap text in inline code formatting. */
export const formatInlineCode = (code: string): string => `\`${code.replace(/`/g, "\\`")}\``;

/** Wrap text in bold formatting. */
export const formatBold = (text: string): string => `*${escapeMarkdownV2(text)}*`;

/** Wrap code in a code block, optionally with language. */
export const formatCodeBlock = (code: string, lang?: string): string => {
  const escaped = code.replace(/```/g, "\\`\\`\\`");
  return lang ? `\`\`\`${lang}\n${escaped}\n\`\`\`` : `\`\`\`\n${escaped}\n\`\`\``;
};
