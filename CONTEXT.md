# Mizook Context

## Glossary

### Artifact

A standalone HTML page stored in R2 and served at `/artifacts/{name}`. Created via the `write_artifact` tool. Content type is always `text/html`. Overwrites on re-creation. Each artifact receives injected shared resources (Tailwind v4, Alpine.js, custom theme) for consistent styling.

### Artifact Assets

Shared resources stored in R2 under `assets/` prefix, served at `/assets/{name}`. Includes Tailwind browser JS, Alpine.js, and a custom CSS theme. These are injected into every artifact automatically.

### R2 Bucket

`MIZOOK_R2` binding (Cloudflare R2). Stores screenshots under `screenshots/` prefix, artifacts under `artifacts/` prefix, and shared assets under `assets/` prefix.

### Screenshot

A PNG image captured by the headless browser, stored in R2 under `screenshots/{platform}/{chatId}/{timestamp}.png`.
