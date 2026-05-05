# Mizook

Telegram personal assistant running on Cloudflare Workers, powered by Durable Objects and [OpenCode Go](https://opencode.ai/go) for AI.

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) with Workers paid plan (Durable Objects)
- [OpenCode Go](https://opencode.ai/go) subscription (or any OpenAI-compatible API key)
- [Telegram bot](https://t.me/BotFather) token
- [Vite+](https://voidzero.dev/vite-plus) (`vp` CLI)

## Setup

### 1. Install dependencies

```bash
vp install
```

### 2. Configure secrets

Set these with `wrangler secret put`:

```bash
# Telegram bot token (from @BotFather)
wrangler secret put BOT_TOKEN

# OpenCode Go API key (from https://opencode.ai/go)
wrangler secret put OPENCODE_GO_API_KEY

# Comma-separated list of allowed Telegram user IDs
wrangler secret put TELEGRAM_ALLOWED_USER_IDS
```

Optional secrets:

```bash
# Secret token to verify Telegram webhook requests (recommended)
wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

### 3. Local development

```bash
# Create .dev.vars for local secrets
cat > .dev.vars <<EOF
BOT_TOKEN=<your-bot-token>
OPENCODE_GO_API_KEY=<your-opencode-go-key>
TELEGRAM_ALLOWED_USER_IDS=<your-telegram-id>
TELEGRAM_WEBHOOK_SECRET=<random-secret>
EOF

# Start dev server
vp dev
```

### 4. Deploy

```bash
vp deploy

# Set secrets in production
echo <bot-token> | wrangler secret put BOT_TOKEN
echo <api-key> | wrangler secret put OPENCODE_GO_API_KEY
echo <user-id> | wrangler secret put TELEGRAM_ALLOWED_USER_IDS
echo <secret> | wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

### 5. Register webhook

Send `/setwebhook https://your-worker.your-subdomain.workers.dev` to your bot on Telegram.

Or do it manually:

```bash
curl -X POST https://api.telegram.org/bot<BOT_TOKEN>/setWebhook \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-worker.your-subdomain.workers.dev/telegram", "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"}'
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `OPENCODE_GO_API_KEY` | Yes | OpenCode Go API key |
| `TELEGRAM_ALLOWED_USER_IDS` | Yes | Comma-separated Telegram user IDs allowed to use the bot |
| `OPENCODE_GO_MODEL` | No | Model ID (default: `deepseek-v4-flash`) |
| `TELEGRAM_WEBHOOK_SECRET` | No | Secret token for webhook verification |

## Available models

The full model list is at `https://opencode.ai/zen/go/v1/models`. Popular defaults:

- `deepseek-v4-flash` — Fast, cheap (default)
- `kimi-k2.6` — Stronger reasoning
- `deepseek-v4-pro` — Most capable

## Commands

| Command | Description |
|---|---|
| `/start` | Greeting message |

## Architecture

```
Telegram → Webhook → Cloudflare Worker → Durable Object (per chat)
                                              ↓
                                    OpenCode Go API (AI)
```

- Each Telegram chat gets its own Durable Object for isolated state
- Messages stream from the model to Telegram via inline edits
- Webhook secret verification ensures only Telegram can call the endpoint