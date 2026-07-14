# Mizook

Telegram personal assistant running on Cloudflare Workers, powered by Durable Objects, [Chat SDK](https://chat-sdk.dev), and [OpenCode Go](https://opencode.ai/go) for AI.

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

### 3. Local development

```bash
# Create .dev.vars for local secrets
cat > .dev.vars <<EOF
BOT_TOKEN=<your-bot-token>
OPENCODE_GO_API_KEY=<your-opencode-go-key>
TELEGRAM_ALLOWED_USER_IDS=<your-telegram-id>
EOF

# Start dev server
vp dev
```

### 4. Deploy

```bash
vp deploy

# Set secrets in production
wrangler secret put BOT_TOKEN
wrangler secret put OPENCODE_GO_API_KEY
wrangler secret put TELEGRAM_ALLOWED_USER_IDS
```

## Configuration

| Variable                    | Required | Description                                                       |
| --------------------------- | -------- | ----------------------------------------------------------------- |
| `BOT_TOKEN`                 | Yes      | Telegram bot token from @BotFather                                |
| `OPENCODE_GO_API_KEY`       | Yes      | OpenCode Go API key                                               |
| `TELEGRAM_ALLOWED_USER_IDS` | Yes      | Comma-separated Telegram user IDs allowed to use the bot          |
| `OPENCODE_GO_MODEL`         | No       | Model ID (default: `deepseek-v4-flash`)                           |
| `TIMEZONE`                  | No       | IANA timezone for the user (default: `Asia/Jakarta`/UTC+7)        |
| `EXA_API_KEY`               | No       | Exa API key for web search (MCP integration)                      |
| `CF_API_TOKEN`              | No       | Cloudflare API token for resource management                      |
| `BASE_URL`                  | No       | Base URL for artifact links (default: `https://mzk.elianiva.com`) |

## Available models

The full model list is at `https://opencode.ai/zen/go/v1/models`. Popular defaults:

- `deepseek-v4-flash` — Fast, cheap (default)
- `kimi-k2.6` — Stronger reasoning
- `deepseek-v4-pro` — Most capable

## Features

### AI Chat

- Conversational AI powered by OpenCode Go (DeepSeek, Kimi, etc.)
- Streaming responses with real-time updates
- Persistent memory for user preferences and context
- Full-text search across conversation history
- Automatic context compaction for long conversations

### Web Search & Fetch

- Search the internet for current information via Exa MCP
- Fetch full content from any URL for detailed analysis

### Cloudflare API

- Full access to your Cloudflare resources (domains, DNS, Workers, KV, R2, D1, etc.)
- Query and manage resources via natural language

### Reminders

- One-time reminders with duration (e.g. "30m", "2h", "1d")
- Recurring reminders with cron expressions (e.g. "daily at 8am")
- List and cancel active reminders

### Browser Screenshots

- Capture screenshots of any website using headless browser
- Send screenshots directly to chat
- Viewport and wait options for accurate captures

### HTML Artifacts

- Generate standalone HTML pages (calculators, dashboards, reports, etc.)
- Store and manage artifacts in R2
- Tailwind CSS v4 and Alpine.js pre-configured
- Public URL for each artifact

### Commands

| Command  | Description                        |
| -------- | ---------------------------------- |
| `/start` | Greeting message                   |
| `/reset` | Clear conversation and start fresh |

## Architecture

```
Telegram → Webhook → Chat SDK → Cloudflare Worker → Durable Object (per chat)
                                                            ↓
                                                  OpenCode Go API (AI)
```

- [Chat SDK](https://chat-sdk.dev) handles Telegram webhook handling and event routing
- Each Telegram chat gets its own Durable Object for isolated AI conversation state
- Messages stream from the model to Telegram via post+edit (500ms throttle)
- Webhook secret verification is handled by the Telegram adapter
- [Think](https://developers.cloudflare.com/agents/) (Cloudflare Agents) manages tool orchestration and streaming

### MCP Integrations

| MCP Server | Purpose                     | Required |
| ---------- | --------------------------- | -------- |
| Exa        | Web search and URL fetching | No       |
| Cloudflare | Cloudflare API access       | No       |

### Storage

| Bucket | Purpose                        |
| ------ | ------------------------------ |
| R2     | Screenshots and HTML artifacts |
| DO     | Conversation state and history |
