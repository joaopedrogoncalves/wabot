# OpenClaw

A WhatsApp bot with two features:

1. **Birthday Bot** — reads birthdays from a Google Sheet and sends messages to a WhatsApp group on a cron schedule.
2. **LLM Chatbot** — listens on one or more WhatsApp groups and responds via Claude when @mentioned or addressed by name. Each group maintains its own conversation history.

## Setup

```bash
npm install
cp .env.example .env
# Fill in .env with your credentials
```

On first run the bot will display a QR code — scan it with WhatsApp to authenticate. Session data is stored in `auth_info_baileys/`.

## Usage

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

## Configuration

All configuration is done via environment variables (see `.env.example`).

### Birthday Bot (required)

| Variable | Default | Description |
|---|---|---|
| `WHATSAPP_GROUP_JID` | — | Group to send birthday messages to |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | — | Google service account email |
| `GOOGLE_PRIVATE_KEY` | — | Google service account private key |
| `SPREADSHEET_ID` | — | Google Sheet ID with birthday data |
| `SHEET_NAME` | `Sheet1` | Sheet tab name |
| `BIRTHDAY_MESSAGE_TEMPLATE` | `🎂 Happy Birthday, {name}! ...` | Message template (`{name}` is replaced) |
| `CRON_SCHEDULE` | `* * * * *` | Cron expression for birthday checks |

### LLM Chatbot (optional — disabled if either required var is missing)

| Variable | Default | Description |
|---|---|---|
| `CHAT_GROUP_JID` | — | WhatsApp group JID(s) for the chatbot (comma-separated for multiple) |
| `ANTHROPIC_API_KEY` | — | Claude API key |
| `SYSTEM_PROMPT` | `You are a helpful assistant...` | Bot persona / system prompt |
| `BOT_NAME` | `openclaw` | Keyword prefix that triggers the bot |
| `CLAUDE_MODEL` | `claude-sonnet-4-5-20250929` | Anthropic model ID |
| `CLAUDE_MAX_TOKENS` | `1024` | Max response tokens |

The chatbot triggers when a user either @mentions the bot or starts a message with the `BOT_NAME` keyword. Each group keeps its own buffer of the last 50 messages as context for Claude.

## Project Structure

```
src/
  index.ts          Entry point
  config.ts         Environment variable loading
  whatsapp.ts       Baileys connection management
  sheets.ts         Google Sheets integration
  birthday.ts       Birthday date logic
  cron.ts           Scheduled birthday checks
  chat-handler.ts   Chatbot message listener & trigger logic
  chat-history.ts   In-memory message buffer for LLM context
  llm.ts            Claude API integration
```
