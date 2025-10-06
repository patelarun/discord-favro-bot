# Discord + Favro Timesheet Bot

This bot adds:
- `/linkfavro email:<you@company.com>`  → link your Discord to your Favro user
- `/unlinkfavro`                        → remove the link
- `/timesheet`                          → post **today's** timesheet entries (description + time) in the channel

## 1) One-time: Register Slash Commands (local)
Create a `.env` beside this file (copy `.env.example` and fill in values), then run:

```bash
npm install
npm run register
