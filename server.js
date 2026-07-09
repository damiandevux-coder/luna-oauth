/**
 * Luna OAuth Service
 * 
 * Handles Slack OAuth installation flow:
 * 1. User clicks "Add to Slack" on landing page
 * 2. Redirected to Slack OAuth
 * 3. Slack redirects back to /slack/callback with ?code=xxx
 * 4. We exchange code for access_token
 * 5. Store workspace token in SQLite
 * 6. Agent polls /workspaces to pick up new installations
 */

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

// ─── Database ───
const db = new Database(process.env.DB_PATH || './luna-oauth.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL UNIQUE,
    team_name TEXT,
    access_token TEXT NOT NULL,
    bot_user_id TEXT,
    scope TEXT,
    installed_by TEXT,
    installed_at INTEGER DEFAULT (unixepoch()),
    configured_at INTEGER,
    is_active INTEGER DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_workspaces_team ON workspaces(team_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_active ON workspaces(is_active, configured_at);
`);

// ─── Config ───
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || 'http://localhost:3001/slack/callback';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'dev-key-change-me';
const PORT = process.env.PORT || 3001;

if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
  console.error('❌ Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET');
  process.exit(1);
}

// ─── Helper: Slack OAuth Exchange ───
async function exchangeSlackCode(code) {
  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    client_secret: SLACK_CLIENT_SECRET,
    code,
    redirect_uri: SLACK_REDIRECT_URI,
  });

  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  return res.json();
}

// ─── Routes ───

/**
 * GET /health
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'luna-oauth', version: '1.0.0' });
});

/**
 * GET /slack/install
 * Redirects user to Slack OAuth
 */
app.get('/slack/install', (req, res) => {
  const scopes = [
    'app_mentions:read',
    'channels:history',
    'channels:read',
    'chat:write',
    'groups:history',
    'groups:read',
    'im:history',
    'im:read',
    'im:write',
    'mpim:history',
    'mpim:read',
    'mpim:write',
    'reactions:read',
    'reactions:write',
    'users:read',
  ].join(',');

  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', SLACK_CLIENT_ID);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('redirect_uri', SLACK_REDIRECT_URI);
  url.searchParams.set('state', 'luna-install');

  res.redirect(url.toString());
});

/**
 * GET /slack/callback
 * Slack redirects here after user authorizes
 */
app.get('/slack/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    console.error('❌ Slack OAuth error:', error);
    return res.status(400).json({ error: 'OAuth failed', detail: error });
  }

  if (!code) {
    return res.status(400).json({ error: 'Missing code parameter' });
  }

  try {
    const data = await exchangeSlackCode(code);

    if (!data.ok) {
      console.error('❌ Slack API error:', data.error);
      return res.status(400).json({ error: 'Slack API error', detail: data.error });
    }

    const { team, access_token, bot_user_id, scope, authed_user } = data;

    // Store workspace
    const stmt = db.prepare(`
      INSERT INTO workspaces (id, team_id, team_name, access_token, bot_user_id, scope, installed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET
        access_token = excluded.access_token,
        bot_user_id = excluded.bot_user_id,
        scope = excluded.scope,
        is_active = 1,
        configured_at = NULL
    `);

    const id = `ws_${team.id}_${Date.now()}`;
    stmt.run(
      id,
      team.id,
      team.name,
      access_token,
      bot_user_id,
      scope,
      authed_user?.id || null
    );

    console.log(`✅ Workspace installed: ${team.name} (${team.id})`);

    // Redirect to success page (your landing page)
    const successUrl = process.env.SUCCESS_REDIRECT_URL || 'https://po-agent-landing.vercel.app/success';
    res.redirect(`${successUrl}?team=${encodeURIComponent(team.name)}`);

  } catch (err) {
    console.error('❌ OAuth callback error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── Agent API (protected) ───

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * GET /workspaces
 * Agent polls this to get unconfigured workspaces
 */
app.get('/workspaces', requireApiKey, (req, res) => {
  const stmt = db.prepare(`
    SELECT id, team_id, team_name, bot_user_id, scope, installed_at
    FROM workspaces
    WHERE is_active = 1 AND configured_at IS NULL
    ORDER BY installed_at ASC
  `);

  const workspaces = stmt.all();
  res.json({ workspaces });
});

/**
 * GET /workspaces/all
 * List all workspaces (for admin/debug)
 */
app.get('/workspaces/all', requireApiKey, (req, res) => {
  const stmt = db.prepare(`
    SELECT id, team_id, team_name, bot_user_id, scope, installed_at, configured_at, is_active
    FROM workspaces
    ORDER BY installed_at DESC
  `);

  const workspaces = stmt.all();
  res.json({ workspaces, count: workspaces.length });
});

/**
 * POST /workspaces/:id/configured
 * Agent calls this after successfully adding workspace to its config
 */
app.post('/workspaces/:id/configured', requireApiKey, (req, res) => {
  const stmt = db.prepare(`
    UPDATE workspaces SET configured_at = unixepoch() WHERE id = ?
  `);
  const result = stmt.run(req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  res.json({ ok: true });
});

/**
 * DELETE /workspaces/:id
 * Deactivate a workspace (uninstall)
 */
app.delete('/workspaces/:id', requireApiKey, (req, res) => {
  const stmt = db.prepare(`
    UPDATE workspaces SET is_active = 0, configured_at = NULL WHERE id = ?
  `);
  const result = stmt.run(req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  res.json({ ok: true });
});

/**
 * GET /workspaces/:id/token
 * Get access token for a workspace (use sparingly, only when needed)
 */
app.get('/workspaces/:id/token', requireApiKey, (req, res) => {
  const stmt = db.prepare(`
    SELECT team_id, access_token FROM workspaces WHERE id = ? AND is_active = 1
  `);
  const row = stmt.get(req.params.id);

  if (!row) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  res.json({ team_id: row.team_id, access_token: row.access_token });
});

// ─── Start ───
app.listen(PORT, () => {
  console.log(`🌙 Luna OAuth service running on port ${PORT}`);
  console.log(`   Install URL: http://localhost:${PORT}/slack/install`);
  console.log(`   Callback:    ${SLACK_REDIRECT_URI}`);
});
