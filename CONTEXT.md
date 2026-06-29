# Mizook Context

## Glossary

### Artifact

A standalone HTML page stored in R2 and served at `/artifacts/{name}`. Created via the `write_artifact` tool. Content type is always `text/html`. Overwrites on re-creation.

### R2 Bucket

`MIZOOK_R2` binding (Cloudflare R2). Stores screenshots under `screenshots/` prefix and artifacts under `artifacts/` prefix.

### Screenshot

A PNG image captured by the headless browser, stored in R2 under `screenshots/{platform}/{chatId}/{timestamp}.png`.
