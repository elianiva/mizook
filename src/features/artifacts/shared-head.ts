/**
 * Shared <head> content injected into every artifact.
 * Ensures consistent styling via Tailwind v4 + Alpine.js + custom theme.
 */
export function getSharedHeadContent(): string {
  return `
    <script src="/assets/tailwind-browser.js"></script>
    <script src="/assets/alpine.min.js" defer></script>
    <link rel="stylesheet" href="/assets/shared.css">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">`.trim();
}

/**
 * Inject shared head content into HTML.
 * If <head> exists, appends to it. Otherwise creates a minimal structure.
 */
export function injectSharedHead(html: string): string {
  const head = getSharedHeadContent();

  if (html.includes("</head>")) {
    return html.replace("</head>", `${head}\n</head>`);
  }

  if (html.includes("<html")) {
    return html.replace(/<html[^>]*>/, `$&\n<head>\n${head}\n</head>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
${head}
</head>
<body>
${html}
</body>
</html>`;
}
