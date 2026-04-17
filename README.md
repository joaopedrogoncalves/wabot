# WABot

WABot is a WhatsApp group bot for persistent group automation. It combines scheduled event reminders, persona-driven multi-model replies, Gemini image generation, passive group memory, and cron-driven autonomous posts.

Core features:

1. **Events bot**: reads rows from a Google Sheet and sends scheduled messages to configured groups.
2. **LLM chatbot**: replies in configured groups through a per-group text model selector (Claude, Gemini, or Gemma), with optional web search, X/Twitter link enrichment, Gemini image generation, rate limiting, and a small web admin UI.
3. **Scheduled autonomous posts**: runs cron-driven prompt jobs that look at recent chat context, optionally search the web, ingest the latest local news digest, and publish an image+caption post even without a trigger.
4. **Passive group memory**: records messages and refreshes member summaries for all configured groups, even if chatbot replies are disabled there.

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
| `ANTHROPIC_API_KEY` | For enabled chatbot groups | Anthropic API key used for text replies, media post planning, and profile summarization |
| `GEMINI_API_KEY` | No | Enables Gemini image generation and Veo video generation |
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
    "chatMaxOutputTokens": 1024,
    "geminiImageModel": "gemini-3.1-flash-image-preview",
    "geminiVideoModel": "veo-3.1-fast-generate-preview",
    "defaultChatModelId": "1a",
    "chatModels": [
      {
        "id": "1a",
        "label": "Claude Sonnet 4.6",
        "provider": "anthropic",
        "apiModel": "claude-sonnet-4-6",
        "supportsWebSearch": true,
        "supportsThinking": true,
        "supportsThinkingConfig": true
      },
      {
        "id": "1d",
        "label": "Gemini 3.1 Pro",
        "provider": "google",
        "apiModel": "gemini-3.1-pro-preview",
        "supportsWebSearch": true,
        "supportsThinking": true,
        "supportsThinkingConfig": true
      },
      {
        "id": "1g",
        "label": "Gemma 4 31B",
        "provider": "google",
        "apiModel": "gemma-4-31b-it",
        "supportsWebSearch": false,
        "supportsThinking": true,
        "supportsThinkingConfig": false
      }
    ]
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
        "allowedModelIds": ["1a", "1d", "1g"],
        "defaultModelId": "1a",
        "activeModelId": "1a",
        "enableThinking": true,
        "thinkingBudget": 2000,
        "enableWebSearch": true,
        "maxSearches": 3,
        "hotness": 35,
        "responseRateLimitCount": 5,
        "responseRateLimitWindowSec": 60,
        "responseRateLimitWarn": true,
        "enableImageGeneration": true,
        "enableVideoGeneration": true,
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
| `claudeModel` | `claude-sonnet-4-6` | Anthropic model used by the background Anthropic-only flows such as scheduled-post drafting and profile summarization |
| `claudeMaxTokens` | `1024` | Legacy Anthropic output cap used by existing Anthropic-only flows |
| `chatMaxOutputTokens` | `1024` | Max output tokens for normal chatbot replies across all chat providers |
| `geminiImageModel` | `gemini-3.1-flash-image-preview` | Gemini model used for image generation |
| `geminiVideoModel` | `veo-3.1-fast-generate-preview` | Veo model used for explicit video requests |
| `defaultChatModelId` | first configured `chatModels` entry | Default group reply model id |
| `chatModels` | built-in catalog | Global catalog of selectable chat reply models, including per-model capability flags such as web search and explicit thinking controls |

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

Each configured group keeps its own in-memory message history. The default cap is `400` messages per group and can be changed with `CHAT_HISTORY_MAX`. This passive recording happens even in groups that only use events or scheduled posts, so later prompts and profile refreshes still have context. The bot also periodically summarizes group members into `group_profiles/<group-jid>.json` and feeds those summaries back into later prompts.

Users can inspect and change the active reply model from chat:

1. `<botname>, /model` lists the models allowed in that group
2. `<botname>, /model <id>` switches the active reply model for the group

The allowlist and default are chosen by admins in config or the admin web UI. The current active model is persisted in `groups.json`.

#### Chatbot config fields

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Set to `false` to disable without removing the config |
| `botName` | — | **Required.** Keyword prefix that triggers the bot. Multiple aliases can be provided as a comma-separated string |
| `systemPrompt` | `You are a helpful assistant in a WhatsApp group chat. Be concise and friendly.` | Bot persona / system prompt |
| `allowedModelIds` | `[global.defaultChatModelId]` | Model ids that this group is allowed to switch between |
| `defaultModelId` | first allowed model | Group default reply model |
| `activeModelId` | `defaultModelId` | Currently selected reply model for the group |
| `enableThinking` | `false` | Enable provider thinking/reasoning when the selected model supports it |
| `thinkingBudget` | `2000` | Thinking intensity hint used for provider-specific thinking controls |
| `enableWebSearch` | `false` | Allow web search when the selected model supports it |
| `maxSearches` | `3` | Max web searches per response |
| `hotness` | `35` | Controls how sharp or roasty the reply style can get |
| `responseRateLimitCount` | `5` | Max triggered replies allowed inside the rate limit window |
| `responseRateLimitWindowSec` | `60` | Rate limit window size in seconds |
| `responseRateLimitWarn` | `true` | Send one in-character cooldown warning when the limit is hit |
| `enableImageGeneration` | `true` | Allow Gemini images for explicit image requests |
| `enableVideoGeneration` | `true` | Allow Veo videos for explicit video requests |
| `enableAutoImageReplies` | `false` | Allow the bot to occasionally attach images to normal replies |

If a user message contains `twitter.com`/`x.com` tweet URLs, the bot tries to fetch tweet details through the X API and appends that context to the text sent to the selected reply model. Set `TWITTER_BEARER_TOKEN` to enable this.

Reaction emojis are also generated in the same reply call. The bot nudges models toward broader mood buckets and avoids reusing the same few emojis too often within a group.

### Scheduled posts

Scheduled posts let a group publish an autonomous image+caption message without a trigger. Each job runs on its own cron schedule, looks at recent discussion, can optionally search the web, and also incorporates the latest digest file found under `/mnt/multimedia/claw/news/` when available before drafting a post and a companion image brief.

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

### Image and video generation

If `GEMINI_API_KEY` is set, the chatbot can attach Gemini-generated images and Veo-generated videos:

- `enableImageGeneration`: handles direct requests such as "bot, make a meme about this"
- `enableVideoGeneration`: handles direct requests such as "bot, make a short video about this"; the bot reacts to the request while Veo runs, then sends the MP4 when it is ready
- `enableAutoImageReplies`: lets the bot decide when an image would improve a reply, with a cooldown between auto-generated images

If Gemini is not configured, the chatbot still replies in text.

### Web admin

If `ADMIN_TOKEN` is set, the bot starts an Express server at `http://localhost:WEB_PORT/admin?token=...`.

- `/admin` shows all known groups and links to group editors
- `/admin/global` edits `global` config fields stored in `groups.json`
- `/admin/group/:jid` edits chatbot, per-group model allowlists/defaults, events, and scheduled-post settings for a group, can regenerate its `webToken`, and can send manual group posts
- `/group/:webToken` is a shareable per-group page for that group's chatbot, event, scheduled-post, and manual posting controls

The group pages include a "Post To Group" panel:

- Send exact message: posts the entered text as the bot without rewriting it
- Generate image post: drafts a persona-aware caption and image prompt, generates the image, then posts it to the group
- Generate video post: drafts a persona-aware caption and Veo prompt, starts video generation in the background, then posts the MP4 when ready

The same panel shows recent manual post status for the group, including active generation stages, sent confirmations, and failures. This status is kept in memory and resets when the bot restarts.

Saving event or scheduled-post settings in the web UI immediately rebuilds the live cron schedule; a bot restart is not required for those edits to take effect.

## Project Structure

```
src/
  index.ts          Entry point
  config.ts         Config loading and validation
  whatsapp.ts       Baileys connection management
  sheets.ts         Google Sheets integration
  events.ts         Event date logic
  cron.ts           Scheduled event checks and autonomous post jobs
  chat-handler.ts   Passive message recorder plus chatbot trigger/reply logic
  chat-history.ts   In-memory group history used for prompts and recaps
  llm.ts            Claude prompt building and reply generation
  gemini.ts         Gemini image generation
  news.ts           Latest local news digest loader for scheduled posts
  group-profiles.ts Member profile summarization
  twitter.ts        X/Twitter URL enrichment
  web/              Admin web interface
```
