# WABot

WABot is a WhatsApp group bot with three main features:

1. **Events bot**: reads rows from a Google Sheet and sends scheduled messages to configured groups.
2. **LLM chatbot**: replies in configured groups through Anthropic Claude, with optional web search, X/Twitter link enrichment, Gemini image generation, rate limiting, and a small web admin UI.
3. **Scheduled autonomous posts**: runs cron-driven prompt jobs that look at recent chat context, optionally search the web, and publish an image+caption post even without a trigger.

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

# Production with auto-restart if the process exits
npm run start:loop

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

If WhatsApp reports a session conflict, another process is using the same auth state. Stop the other instance before restarting this bot.

### Finding group JIDs

On startup the bot prints all groups it belongs to with their JIDs:

```
--- Groups ---
  Family Group → 120363000000000000@g.us
  Tech Friends → 120363000000000001@g.us
--- End Groups ---
```

These JIDs are automatically synced into your `groups.json` config file on startup. New groups are appended with a generated `webToken`, and existing group names are refreshed from WhatsApp. You can also inspect them in the web admin panel if `ADMIN_TOKEN` is set.

## Configuration

Configuration is split between environment variables (`.env`) for secrets and a JSON file (`groups.json`) for per-group settings.

### Environment variables (`.env`)

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | For enabled chatbot groups | Anthropic API key used for text replies and profile summarization |
| `GEMINI_API_KEY` | No | Enables Gemini image generation for direct image requests and automatic image replies |
| `TWITTER_BEARER_TOKEN` | No | X/Twitter API bearer token used to enrich `twitter.com` / `x.com` links with tweet text and metrics |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | For groups with `events` | Google service account email |
| `GOOGLE_PRIVATE_KEY` | For groups with `events` | Google service account private key |
| `CONFIG_FILE` | No | Path to group config file (default: `./groups.json`) |
| `CHAT_HISTORY_MAX` | No | Max in-memory messages kept per group for LLM context (default: `400`) |
| `ADMIN_TOKEN` | No | Enables the web admin panel at `http://host:WEB_PORT/admin?token=...` |
| `WEB_PORT` | No | Web admin port (default: `3000`) |

### Group config (`groups.json`)

Each group can have an `events` config, a `chatbot` config, or both. See `groups.example.json` for a full example.

```json
{
  "global": {
    "claudeModel": "claude-sonnet-4-6",
    "claudeMaxTokens": 1024,
    "geminiImageModel": "gemini-3.1-flash-image-preview"
  },
  "groups": [
    {
      "jid": "120363000000000000@g.us",
      "name": "Family Group",
      "webToken": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "events": {
        "spreadsheetId": "1aBcDeFgHiJkLmNoPqRsTuVwXyZ",
        "sheetName": "Sheet1",
        "messageTemplate": "🎂 Happy Birthday, {name}! 🎉",
        "cronSchedule": "0 8 * * *"
      },
      "chatbot": {
        "enabled": true,
        "botName": "familybot, fbot",
        "systemPrompt": "You are a warm family assistant.",
        "enableThinking": true,
        "thinkingBudget": 2000,
        "enableWebSearch": true,
        "maxSearches": 3,
        "hotness": 35,
        "responseRateLimitCount": 5,
        "responseRateLimitWindowSec": 60,
        "responseRateLimitWarn": true,
        "enableImageGeneration": true,
        "enableAutoImageReplies": false
      },
      "scheduledPosts": [
        {
          "label": "morning-news-roundup",
          "cronSchedule": "0 8 * * *",
          "prompt": "Every morning, review the last day of discussion, search the web for major news when useful, correct any factual mistakes made in chat, and post a concise roundup with one companion image.",
          "lookbackHours": 24,
          "enableWebSearch": true,
          "maxSearches": 3
        }
      ]
    }
  ]
}
```

`groups.example.json` contains a fuller sample. In practice, `groups.json` is usually created and kept up to date by startup sync.

### Group object fields

| Field | Required | Description |
|---|---|---|
| `jid` | Yes | WhatsApp group JID |
| `name` | No | Friendly name, refreshed from WhatsApp on startup |
| `webToken` | No | Token used by the shareable per-group settings page; generated automatically if missing |
| `events` | No | Events bot settings for the group |
| `chatbot` | No | Chatbot settings for the group |
| `scheduledPosts` | No | Array of cron-driven autonomous posting jobs for the group |

### Global config fields

| Field | Default | Description |
|---|---|---|
| `claudeModel` | `claude-sonnet-4-6` | Anthropic model used for chatbot replies |
| `claudeMaxTokens` | `1024` | Max output tokens for chatbot replies |
| `geminiImageModel` | `gemini-3.1-flash-image-preview` | Gemini model used for image generation |

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

Only the day and month are used for matching; the year is ignored. The bot fetches the sheet fresh on each scheduled run and sends one message per matching row.

### LLM Chatbot

The chatbot triggers when a user:

1. @mentions the bot
2. starts a message with the configured `botName`
3. replies to one of the bot's messages
4. edits a message so it now starts with `botName` or mentions the bot

Each group keeps its own in-memory conversation history for Claude. The default cap is `400` messages per group and can be changed with `CHAT_HISTORY_MAX`. The bot also periodically summarizes group members into `group_profiles/<group-jid>.json` and feeds those summaries back into later prompts.

#### Chatbot config fields

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Set to `false` to disable without removing the config |
| `botName` | — | **Required.** Keyword prefix that triggers the bot. Multiple aliases can be provided as a comma-separated string |
| `systemPrompt` | `You are a helpful assistant in a WhatsApp group chat. Be concise and friendly.` | Bot persona / system prompt |
| `enableThinking` | `false` | Enable Claude's extended thinking |
| `thinkingBudget` | `2000` | Max thinking tokens (only used if thinking is enabled) |
| `enableWebSearch` | `false` | Allow Claude to search the web |
| `maxSearches` | `3` | Max web searches per response |
| `hotness` | `35` | Controls how sharp or roasty the reply style can get |
| `responseRateLimitCount` | `5` | Max triggered replies allowed inside the rate limit window |
| `responseRateLimitWindowSec` | `60` | Rate limit window size in seconds |
| `responseRateLimitWarn` | `true` | Send one in-character cooldown warning when the limit is hit |
| `enableImageGeneration` | `true` | Allow Gemini images for explicit image requests |
| `enableAutoImageReplies` | `false` | Allow the bot to occasionally attach images to normal replies |

If a user message contains `twitter.com`/`x.com` tweet URLs, the bot tries to fetch tweet details through the X API and appends that context to the text sent to Claude. Set `TWITTER_BEARER_TOKEN` to enable this.

Reaction emojis are also generated by Claude in the same reply call. The bot now nudges Claude toward broader mood buckets and avoids reusing the same few emojis too often within a group.

### Scheduled posts

Scheduled posts let a group publish an autonomous image+caption message without a trigger. Each job runs on its own cron schedule, looks at recent discussion, and can optionally search the web before drafting a post and a companion image brief.

#### Scheduled post config fields

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Set to `false` to disable the job without removing it |
| `label` | `scheduled-post-N` | Human-friendly label used in logs |
| `cronSchedule` | — | Cron expression for when the job should run |
| `prompt` | — | Main instruction for what the autonomous post should do |
| `lookbackHours` | `24` | How many hours of recent group discussion to include |
| `enableWebSearch` | `false` | Allow the scheduled job to use Claude web search |
| `maxSearches` | `3` | Max web searches for that job run |

If Gemini image generation fails for a scheduled job, the bot falls back to posting the caption as plain text.

### Image generation

If `GEMINI_API_KEY` is set, the chatbot can attach Gemini-generated images:

- `enableImageGeneration`: handles direct requests such as "bot, make a meme about this"
- `enableAutoImageReplies`: lets the bot decide when an image would improve a reply, with a cooldown between auto-generated images

If Gemini is not configured, the chatbot still replies in text.

### Web admin

If `ADMIN_TOKEN` is set, the bot starts an Express server at `http://localhost:WEB_PORT/admin?token=...`.

- `/admin` shows all known groups and links to group editors
- `/admin/global` edits `global` config fields stored in `groups.json`
- `/admin/group/:jid` edits chatbot and events settings for a group and can regenerate its `webToken`
- `/group/:webToken` is a shareable per-group settings page for chatbot options only

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
  llm.ts            Claude prompt building and reply generation
  gemini.ts         Gemini image generation
  group-profiles.ts Member profile summarization
  twitter.ts        X/Twitter URL enrichment
  web/              Admin web interface
```
