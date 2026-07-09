/**
 * Luna OAuth Service — Same-Machine Edition
 * 
 * Runs inside the same container as the OpenClaw agent.
 * Writes workspace tokens directly to openclaw.json.
 */

const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

// ─── Config ───
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = proces…RET;
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI;
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
const PORT = process.env.PORT || 3001;

if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET || !SLACK_REDIRECT_URI) {
  console.error('❌ Missing required env: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_REDIRECT_URI');
  process.exit(1);
}

// ─── Database (for tracking, not required for operation) ───
const dbPath = process.env.DB_PATH || './luna-oauth.db';
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    team_id TEXT PRIMARY KEY,
    team_name TEXT,
    access_token TEXT NOT NULL,
    bot_user_id TEXT,
    scope TEXT,
    installed_at INTEGER DEFAULT (unixepoch()),
    is_active INTEGER DEFAULT 1
  );
`);

// ─── Helpers ───
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

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8'));
  } catch (err) {
    console.error('❌ Cannot read openclaw.json:', err.message);
    return null;
  }
}

function writeConfig(config) {
  fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function addSlackAccount(config, teamId, token) {
  if (!config.channels) config.channels = {};
  if (!config.channels.slack) {
    config.channels.slack = { enabled: true, mode: 'socket' };
  }
  if (!config.channels.slack.accounts) {
    config.channels.slack.accounts = {};
  }

  const accountId = `luna_${teamId}`;
  config.channels.slack.accounts[accountId] = {
    botToken: token,
  };

  return config;
}

// ─── Routes ───

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'luna-oauth', configPath: OPENCLAW_CONFIG_PATH });
});

app.get('/slack/install', (req, res) => {
  const scopes = [
    'app_mentions:read','channels:history','channels:read','chat:write',
    'groups:history','groups:read','im:history','im:read','im:write',
    'mpim:history','mpim:read','mpim:write','reactions:read',
    'reactions:write','users:read',
  ].join(',');

  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', SLACK_CLIENT_ID);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('redirect_uri', SLACK_REDIRECT_URI);
  url.searchParams.set('state', 'luna');
  res.redirect(url.toString());
});

app.get('/slack/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (!code) return res.status(400).send('Missing code');

  try {
    const data = await exchangeSlackCode(code);
    if (!data.ok) throw new Error(data.error);

    const { team, access_token, bot_user_id, scope } = data;

    // Save to DB
    db.prepare(`
      INSERT INTO workspaces (team_id, team_name, access_token, bot_user_id, scope)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET
        access_token=excluded.access_token, bot_user_id=excluded.bot_user_id,
        scope=excluded.scope, is_active=1
    `).run(team.id, team.name, access_token, bot_user_id, scope);

    // Write directly to openclaw.json
    const config = readConfig();
    if (config) {
      const updated = addSlackAccount(config, team.id, access_token);
      writeConfig(updated);
      console.log(`✅ Workspace added: ${team.name} (${team.id})`);
    }

    // Redirect to success page
    const successUrl = process.env.SUCCESS_REDIRECT_URL || 'https://po-agent-landing.vercel.app';
    res.redirect(`${successUrl}?installed=${encodeURIComponent(team.name)}`);

  } catch (err) {
    console.error('❌ Callback error:', err);
    res.status(500).send('Installation failed. Please try again.');
  }
});

app.get('/workspaces', (req, res) => {
  const rows = db.prepare('SELECT team_id, team_name, installed_at FROM workspaces WHERE is_active=1').all();
  res.json({ workspaces: rows });
});

// ─── Start ───
app.listen(PORT, () => {
  console.log(`🌙 Luna OAuth running on port ${PORT}`);
  console.log(`   Config: ${OPENCLAW_CONFIG_PATH}`);
  console.log(`   Callback: ${SLACK_REDIRECT_URI}`);
});
