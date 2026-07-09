/**
 * Agent Sync Script
 * 
 * Run this from the OpenClaw agent to poll for new Slack workspaces
 * and automatically add them to the agent's config.
 * 
 * Usage: node agent-sync.js
 * 
 * This should be run periodically (e.g., via cron or heartbeat).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  // URL of the OAuth service
  oauthServiceUrl: process.env.LUNA_OAUTH_URL || 'http://localhost:3001',
  
  // API key for the OAuth service
  apiKey: process.env.LUNA_OAUTH_API_KEY || 'dev-key-change-me',
  
  // OpenClaw config file path
  openclawConfigPath: process.env.OPENCLAW_CONFIG_PATH || path.join(require('os').homedir(), '.openclaw', 'openclaw.json'),
};

async function fetchWorkspaces() {
  const res = await fetch(`${CONFIG.oauthServiceUrl}/workspaces`, {
    headers: { 'X-API-Key': CONFIG.apiKey },
  });
  
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  
  return res.json();
}

async function markConfigured(workspaceId) {
  const res = await fetch(`${CONFIG.oauthServiceUrl}/workspaces/${workspaceId}/configured`, {
    method: 'POST',
    headers: { 'X-API-Key': CONFIG.apiKey },
  });
  
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  
  return res.json();
}

function readOpenClawConfig() {
  try {
    const raw = fs.readFileSync(CONFIG.openclawConfigPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('❌ Failed to read openclaw.json:', err.message);
    return null;
  }
}

function writeOpenClawConfig(config) {
  fs.writeFileSync(CONFIG.openclawConfigPath, JSON.stringify(config, null, 2) + '\n');
}

async function addWorkspaceToConfig(workspace) {
  const config = readOpenClawConfig();
  if (!config) return false;

  // Ensure channels.slack exists
  if (!config.channels) config.channels = {};
  if (!config.channels.slack) config.channels.slack = { enabled: true };
  if (!config.channels.slack.accounts) config.channels.slack.accounts = {};

  // Add workspace as a named account
  const accountId = `luna_${workspace.team_id}`;
  
  // Check if already exists
  if (config.channels.slack.accounts[accountId]) {
    console.log(`⚠️  Workspace ${workspace.team_name} already configured`);
    return false;
  }

  // Fetch the token from OAuth service
  const tokenRes = await fetch(`${CONFIG.oauthServiceUrl}/workspaces/${workspace.id}/token`, {
    headers: { 'X-API-Key': CONFIG.apiKey },
  });
  
  if (!tokenRes.ok) {
    throw new Error(`Failed to get token: ${tokenRes.status}`);
  }
  
  const { access_token } = await tokenRes.json();

  // Add account to config
  config.channels.slack.accounts[accountId] = {
    botToken: access_token,
    // Optional: restrict which channels Luna can access
    // allowFrom: ["channel-id-1", "channel-id-2"],
  };

  writeOpenClawConfig(config);
  console.log(`✅ Added workspace to config: ${workspace.team_name} (${accountId})`);
  
  return true;
}

async function runSync() {
  console.log('🌙 Luna Agent Sync — checking for new workspaces...');
  console.log(`   Config: ${CONFIG.openclawConfigPath}`);
  console.log(`   OAuth:  ${CONFIG.oauthServiceUrl}`);
  
  try {
    const { workspaces } = await fetchWorkspaces();
    
    if (workspaces.length === 0) {
      console.log('   No new workspaces to configure.');
      return;
    }
    
    console.log(`   Found ${workspaces.length} new workspace(s)`);
    
    for (const ws of workspaces) {
      try {
        const added = await addWorkspaceToConfig(ws);
        if (added) {
          await markConfigured(ws.id);
        }
      } catch (err) {
        console.error(`   ❌ Failed to configure ${ws.team_name}:`, err.message);
      }
    }
    
    console.log('   Sync complete.');
    
  } catch (err) {
    console.error('❌ Sync failed:', err.message);
    process.exit(1);
  }
}

runSync();
