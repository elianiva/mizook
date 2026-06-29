# ADR 0001: Shared Artifact Styling

## Status

Accepted

## Context

Artifacts are standalone HTML pages created by the LLM via `write_artifact`. Without shared resources, each artifact could have completely different styling, fonts, and visual identity. This creates an inconsistent user experience.

## Decision

Use a shared styling system with server-side injection and prompt guidance:

1. **Self-hosted assets in R2**: Tailwind v4 browser JS, Alpine.js, and custom CSS theme stored under `assets/` prefix
2. **Server-side injection**: `serveArtifact()` injects shared `<head>` content into every artifact before serving
3. **Prompt guidance**: System prompt includes available theme tokens so LLM uses consistent colors/fonts
4. **Theme**: Custom oklch palette with light/dark variants, Space Grotesk (headings), Nunito Sans (body)
5. **Dark mode**: Automatic via `prefers-color-scheme` media query

## Consequences

- Every artifact has consistent styling without LLM needing to include boilerplate
- LLM can use theme tokens (bg-background, text-foreground, etc.) instead of arbitrary colors
- Assets are versioned and self-hosted, no external CDN dependency
- Artifact list page uses same system for visual consistency
