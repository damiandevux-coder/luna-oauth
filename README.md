# Luna OAuth Service

Handles Slack OAuth installation flow for the Luna AI Product Owner agent.

## What It Does

1. **Landing page** → User clicks "Add to Slack"
2. **Slack OAuth** → User picks workspace and authorizes
3. **Callback** → We exchange the OAuth code for an access token
4. **Store** → Save workspace token in SQLite
5. **Agent sync** → OpenClaw agent polls for new workspaces and auto-configures them

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Landing   │────▶│ Slack OAuth  │────▶│   Callback  │
│    Page     │     │   (slack.com)│     │  (this app) │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                 │
                                                 ▼
                                          ┌──────────────┐
                                          │   SQLite DB  │
                                          │  (tokens)    │
                                          └──────┬───────┘
                                                 │
                                                 ▼
                                          ┌──────────────┐
                                          │  Agent Sync  │
                                          │   (cronjob)  │
                                          └──────┬───────┘
                                                 │
                                                 ▼
                                          ┌──────────────┐
                                          │ openclaw.json│
                                          │(new account) │
                                          └──────────────┘
```

## Quick Start

### 1. Configure Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) → Your Luna app:

- **OAuth & Permissions** → Add redirect URL:
  - `http://localhost:3001/slack/callback` (dev)
  - `https://your-oauth-service.com/slack/callback` (prod)

- **Manage Distribution** → Activate Public Distribution

- Note down **Client ID** and **Client Secret**

### 2. Set Up This Service

```bash
git clone https://github.com/damiandevux-coder/luna-oauth.git
cd luna-oauth
cp .env.example .env
# Edit .env with your Slack credentials
npm install
npm start
```

### 3. Update Landing Page

Add the "Add to Slack" button with this URL:

```
https://your-oauth-service.com/slack/install
```

### 4. Configure Agent Sync

On the OpenClaw agent machine, set up the sync script:

```bash
# Set env vars
export LUNA_OAUTH_URL=https://your-oauth-service.com
export LUNA_OAUTH_API_KEY=your-internal-api-key

# Run once to test
node agent-sync.js

# Add to cron (every 5 minutes)
*/5 * * * * cd /path/to/luna-oauth && node agent-sync.js >> /var/log/luna-sync.log 2>&1
```

Or use OpenClaw's heartbeat to trigger it periodically.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |
| GET | `/slack/install` | No | Redirects to Slack OAuth |
| GET | `/slack/callback` | No | Slack OAuth callback |
| GET | `/workspaces` | API Key | List unconfigured workspaces |
| GET | `/workspaces/all` | API Key | List all workspaces |
| POST | `/workspaces/:id/configured` | API Key | Mark workspace as configured |
| DELETE | `/workspaces/:id` | API Key | Deactivate workspace |
| GET | `/workspaces/:id/token` | API Key | Get workspace token |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_CLIENT_ID` | Yes | — | From Slack app settings |
| `SLACK_CLIENT_SECRET` | Yes | — | From Slack app settings |
| `SLACK_REDIRECT_URI` | Yes | — | Must match Slack app config |
| `INTERNAL_API_KEY` | Yes | — | Key for agent ↔ service communication |
| `SUCCESS_REDIRECT_URL` | No | — | Where to redirect after install |
| `DB_PATH` | No | `./luna-oauth.db` | SQLite database path |
| `PORT` | No | `3001` | Server port |

## Deployment

### Option 1: Same Machine as Agent

If the OAuth service runs on the same machine as the OpenClaw gateway:

```bash
# Use localhost for internal comms
SLACK_REDIRECT_URI=http://your-public-domain.com/slack/callback
LUNA_OAUTH_URL=http://localhost:3001
```

### Option 2: Separate Host

If the OAuth service runs separately (e.g., Render, Railway, Fly):

```bash
# Agent needs public URL
LUNA_OAUTH_URL=https://luna-oauth.your-domain.com
```

### Deploy to Render

1. Create new Web Service
2. Connect this repo
3. Set environment variables
4. Done — auto-deploys

## Security Notes

- **Never commit `.env`** — it contains secrets
- **Use strong `INTERNAL_API_KEY`** — protects workspace tokens
- **HTTPS in production** — Slack requires it for OAuth
- **Encrypt tokens at rest** — consider SQLCipher for SQLite

## License

MIT
