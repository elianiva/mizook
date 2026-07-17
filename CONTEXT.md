# Mizook Context

## Glossary

### R2 Bucket

`MIZOOK_R2` binding (Cloudflare R2). Stores screenshots under `screenshots/` prefix.

### Screenshot

A PNG image captured by the headless browser, stored in R2 under `screenshots/{platform}/{chatId}/{timestamp}.png`.
