# WABot

A WhatsApp bot with two features:

1. **Events Bot** — reads events from a Google Sheet and sends messages to a WhatsApp group on a cron schedule.
2. **LLM Chatbot** — listens on one or more WhatsApp groups and responds via Claude when @mentioned or addressed by name. Each group maintains its own conversation history.

## Setup

```bash
npm install
cp .env.example .env
# Fill in .env with your credentials
```

## Usage

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

## WhatsApp Connection

On first run the bot displays a QR code in the terminal — scan it with your phone:

1. Open WhatsApp on your phone
2. Go to **Linked Devices** (Settings → Linked Devices on iOS, or the three-dot menu on Android)
3. Tap **Link a Device** and scan the QR code shown in the terminal

Session data is stored in `auth_info_baileys/`. As long as this directory exists, the bot reconnects automatically without needing to scan again.

If you get logged out (e.g. you removed the linked device from your phone), delete the `auth_info_baileys/` directory and restart the bot to get a new QR code.

### Finding group JIDs

On startup the bot prints all groups it belongs to with their JIDs:

```
--- Groups ---
  Family Group → 120363000000000000@g.us
  Tech Friends → 120363000000000001@g.us
--- End Groups ---
```

These JIDs are automatically synced into your `groups.json` config file. You can also find them in the web admin panel if `ADMIN_TOKEN` is set.

## Configuration

Configuration is split between environment variables (`.env`) for secrets and a JSON file (`groups.json`) for per-group settings.

### Environment variables (`.env`)

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | For chatbot | Claude API key |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | For events | Google service account email |
| `GOOGLE_PRIVATE_KEY` | For events | Google service account private key |
| `CONFIG_FILE` | No | Path to group config file (default: `./groups.json`) |
| `ADMIN_TOKEN` | No | Enables the web admin panel at `http://host:WEB_PORT/admin` |
| `WEB_PORT` | No | Web admin port (default: `3000`) |

### Group config (`groups.json`)

Each group can have an `events` config, a `chatbot` config, or both. See `groups.example.json` for a full example.

```json
{
  "global": {
    "claudeModel": "claude-sonnet-4-5-20250929",
    "claudeMaxTokens": 1024
  },
  "groups": [
    {
      "jid": "120363000000000000@g.us",
      "name": "Family Group",
      "events": {
        "spreadsheetId": "1aBcDeFgHiJkLmNoPqRsTuVwXyZ",
        "sheetName": "Sheet1",
        "messageTemplate": "🎂 Happy Birthday, {name}! 🎉",
        "cronSchedule": "0 8 * * *"
      },
      "chatbot": {
        "botName": "familybot",
        "systemPrompt": "You are a warm family assistant."
      }
    }
  ]
}
```

### Events Bot

The events bot reads rows from a Google Sheet and sends a message to the group when an event matches today's date.

#### Events config fields

| Field | Default | Description |
|---|---|---|
| `spreadsheetId` | — | Google Sheet ID (from the sheet URL) |
| `sheetName` | `Sheet1` | Name of the sheet tab to read |
| `messageTemplate` | `🎂 Happy Birthday, {name}! 🎉 Wishing you an amazing day!` | Message template — `{name}` is replaced with the person's name |
| `cronSchedule` | `0 8 * * *` | Cron expression for when to check (default: daily at 8 AM) |
| `label` | `events` | Label used in log messages |

#### Setting up the Google Sheet

1. **Create a Google Cloud service account:**
   - Go to the [Google Cloud Console](https://console.cloud.google.com/)
   - Create a project (or use an existing one)
   - Enable the **Google Sheets API**
   - Go to **IAM & Admin → Service Accounts** and create a service account
   - Create a JSON key for the service account and download it
   - Copy the `client_email` value into `GOOGLE_SERVICE_ACCOUNT_EMAIL` in your `.env`
   - Copy the `private_key` value into `GOOGLE_PRIVATE_KEY` in your `.env`

2. **Create the spreadsheet:**
   - Create a new Google Sheet (or use an existing one)
   - The sheet must have a header row with at least two columns: **Name** and **Date**
   - Add your events as rows below the header

3. **Share the spreadsheet** with the service account email (the `client_email` from step 1) — give it **Viewer** access.

4. **Get the spreadsheet ID** from the URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit` — copy the ID and put it in your group's `spreadsheetId` config field.

#### Spreadsheet format

The sheet must have a header row with these exact column names:

| Name | Date |
|---|---|
| Alice | 15/03/1990 |
| Bob | 2005-07-22 |
| Charlie | 01/12 |

- **Name** — the person's name (used in `{name}` template replacement)
- **Date** — the event date. Supported formats:
  - `dd/mm/yyyy` (e.g. `15/03/1990`)
  - `dd/mm` (e.g. `15/03` — year is ignored anyway)
  - `yyyy-mm-dd` (e.g. `2005-07-22`)

Only the day and month are used for matching — the year is ignored. The bot checks if any row's date matches today's date and sends the message template for each match.

### LLM Chatbot

The chatbot triggers when a user either @mentions the bot, starts a message with the `botName` keyword, or replies to one of the bot's messages. Each group keeps its own buffer of the last 50 messages as context for Claude.

#### Chatbot config fields

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Set to `false` to disable without removing the config |
| `botName` | — | **Required.** Keyword prefix that triggers the bot |
| `systemPrompt` | `You are a helpful assistant...` | Bot persona / system prompt |
| `enableThinking` | `false` | Enable Claude's extended thinking |
| `thinkingBudget` | `2000` | Max thinking tokens (only used if thinking is enabled) |
| `enableWebSearch` | `false` | Allow Claude to search the web |
| `maxSearches` | `3` | Max web searches per response |

## Project Structure

```
src/
  index.ts          Entry point
  config.ts         Config loading and validation
  whatsapp.ts       Baileys connection management
  sheets.ts         Google Sheets integration
  events.ts         Event date logic
  cron.ts           Scheduled event checks
  chat-handler.ts   Chatbot message listener & trigger logic
  chat-history.ts   In-memory message buffer for LLM context
  llm.ts            Claude API integration
  group-profiles.ts Member profile summarization
  web/              Admin web interface
```
