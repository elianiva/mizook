/**
 * Shared <head> content injected into every artifact.
 * Ensures consistent styling via Tailwind v4 + Alpine.js + custom theme.
 */
const sharedCss = `
@import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Nunito+Sans:wght@400;500;600;700&display=swap");

@theme {
  --font-heading: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
  --font-sans: "Nunito Sans", ui-sans-serif, system-ui, sans-serif;

  --color-background: oklch(1 0 0);
  --color-foreground: oklch(0.145 0.008 326);
  --color-card: oklch(1 0 0);
  --color-card-foreground: oklch(0.145 0.008 326);
  --color-muted: oklch(0.96 0.003 325.6);
  --color-muted-foreground: oklch(0.542 0.034 322.5);
  --color-primary: oklch(0.525 0.223 3.958);
  --color-primary-foreground: oklch(0.971 0.014 343.198);
  --color-secondary: oklch(0.967 0.001 286.375);
  --color-secondary-foreground: oklch(0.21 0.006 285.885);
  --color-accent: oklch(0.96 0.003 325.6);
  --color-accent-foreground: oklch(0.212 0.019 322.12);
  --color-destructive: oklch(0.577 0.245 27.325);
  --color-border: oklch(0.922 0.005 325.62);
  --color-input: oklch(0.922 0.005 325.62);
  --color-ring: oklch(0.711 0.019 23.02);

  --radius: 0.625rem;
}
`;

export function getSharedHeadContent(): string {
  return `
    <script src="/assets/tailwind-browser.js"></script>
    <script src="/assets/alpine.min.js" defer></script>
    <style type="text/tailwindcss">${sharedCss}</style>
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
