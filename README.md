# Discord + Favro Timesheet Bot

A lightweight Discord bot that posts your Favro timesheet updates to any channel, with clean formatting and handy utilities.

## Features
- Publishes today’s Favro time entries for specified cards, publicly in the channel
- Links Discord users to Favro accounts and stores the mapping locally
- Accepts Favro URLs or keys (e.g., `BOK-6074`) and supports direct `cardCommonId`
- Scans multiple boards with pagination and org scoping
- Adds non-Favro notes via an extras field (multi-line) appended as bullets
- Lets users delete their last timesheet message in a channel

## Commands
- `/linkfavro email:<you@company.com>` → Link your Discord to your Favro user (ephemeral)
- `/unlinkfavro` → Unlink your Favro mapping (ephemeral)
- `/timesheet cards:[list] extras:[text]` → Post today’s entries publicly
  - `cards`: keys (e.g., `BOK-6074`), `cardCommonId` (e.g., `8f0048648ed3eb25aee16c0c`)
  - `extras`: optional; semicolon or newline separated free-form bullets (multi-line supported)
  - Output format:
    - Header: `Today's update:`
    - Each entry: `**PREFIX-SEQ** - HH:MM` with a bullet below; bullets end with a period
- `/timesheetdelete` → Delete your last timesheet message in the current channel (ephemeral confirmation)

## Environment
Create a `.env` next to this file with:

```
DISCORD_TOKEN=...          # Bot token
DISCORD_APP_ID=...         # Application (client) ID
DISCORD_GUILD_ID=...       # Target guild for command registration

FAVRO_EMAIL=...            # Favro login email for API
FAVRO_TOKEN=...            # Favro API token
FAVRO_ORG_ID=...           # Favro organization id header

# Boards to scan for key lookups (comma-separated widgetCommonIds)
FAVRO_WIDGET_IDS=

# Optional tuning
FAVRO_MAX_PAGES_PER_WIDGET=10
FAVRO_TIME_CF_ID=irPsbWAaGquxQqxB8     # Custom field id used for time reports
FAVRO_DEFAULT_CARD_PREFIX=BOK          # Fallback prefix if the API omits it
TIMEZONE=Europe/Stockholm
```

## Install & Register Commands
```bash
npm install
npm run register
```

## Run the Bot
```bash
npm start
```

## Usage Examples
- Link your Favro user:
  - `/linkfavro email:you@company.com`
- Post today’s update from two cards and extras:
  - `/timesheet cards:BOK-6074 BOK-5120 extras:"Helped QA; Fixed devops script"`
- Delete your last timesheet message in this channel:
  - `/timesheetdelete`

## Notes
- Timesheet posts are public; link/unlink and delete confirmations are ephemeral.
- The bot persists:
  - `data/user-map.json` → Discord user id to Favro user id mapping
  - `data/last-timesheet.json` → Last message id per user/channel for deletion
- The bot honors Favro’s pagination and organization scoping and persists the `X-Favro-Backend-Identifier` for efficiency.
