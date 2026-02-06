# WhatsApp Birthday Bot

A WhatsApp bot that runs as your own account (via Baileys), reads birthdates from a Google Spreadsheet, and posts a birthday message to a group chat whenever today matches someone's birthday. Runs continuously with a daily cron check at 8:00 AM.

## Tech Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 20+ / TypeScript |
| WhatsApp | `@whiskeysockets/baileys` (multi-device WebSocket API) |
| Google Sheets | `google-spreadsheet` v5 + `google-auth-library` (Service Account JWT) |
| Scheduling | `node-cron` (in-process cron) |
| Logging | `pino` |
| Config | `.env` file via `dotenv` |

## Project Structure

```
src/
  index.ts        # Entry point: init WhatsApp, start cron
  whatsapp.ts     # Connect, auth, send message, list groups
  sheets.ts       # Google Sheets reader
  birthday.ts     # Date matching + message formatting
  config.ts       # Load & validate env vars
  cron.ts         # Schedule the daily birthday check
```

## Prerequisites

- **Node.js 20+** (install via [nvm](https://github.com/nvm-sh/nvm): `nvm install 20`)
- A **Google Cloud service account** with the Sheets API enabled
- A **Google Spreadsheet** shared with the service account email (as Viewer)
- A **WhatsApp account** to pair via QR code

## Setup

1. **Clone the repo and install dependencies:**

   ```bash
   git clone <repo-url>
   cd openclaw
   nvm use 20
   npm install
   ```

2. **Configure environment variables:**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` with your values:

   | Variable | Description |
   |---|---|
   | `WHATSAPP_GROUP_JID` | Target group JID (discover on first run — see below) |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email from GCP |
   | `GOOGLE_PRIVATE_KEY` | Private key from the service account JSON (keep the `\n` escapes) |
   | `SPREADSHEET_ID` | The ID from the spreadsheet URL |
   | `SHEET_NAME` | Sheet tab name (default: `Sheet1`) |
   | `BIRTHDAY_MESSAGE_TEMPLATE` | Message template — use `{name}` as placeholder |
   | `CRON_SCHEDULE` | Cron expression (default: `0 8 * * *` — 8 AM daily) |

3. **Set up the Google Spreadsheet** with this layout:

   | Name | Date |
   |---|---|
   | João | 15/03 |
   | Maria | 28/11 |
   | Pedro | 06/02/1990 |

   - Column A header: `Name`
   - Column B header: `Date` (DD/MM or DD/MM/YYYY — year is optional, only day+month matter)

## Running

```bash
nvm use 20
npm start
```

### First Run

1. A QR code will appear in the terminal — scan it with WhatsApp (Linked Devices)
2. Once connected, the bot logs all your groups with their JIDs:
   ```
   --- Groups ---
     Family Group → 123456789-987654321@g.us
     Work Chat → 987654321-123456789@g.us
   --- End Groups ---
   ```
3. Copy the target group JID into `WHATSAPP_GROUP_JID` in `.env`
4. Restart the bot

### Subsequent Runs

The session is saved in `auth_info_baileys/`, so no QR scan is needed after the first time.

On startup the bot:
1. Connects to WhatsApp
2. Lists all groups (for reference)
3. Runs an immediate birthday check
4. Starts the cron job for daily checks

## Development

```bash
npm run dev   # runs with tsx watch (auto-restart on changes)
```

To test quickly, set `CRON_SCHEDULE=*/1 * * * *` in `.env` to trigger every minute, or add your own birthday as today's date in the spreadsheet — the immediate startup check will send the message.
