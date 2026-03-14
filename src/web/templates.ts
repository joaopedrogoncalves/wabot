import type { AppConfig, GlobalConfig, GroupConfig } from '../config.js';

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLayout(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - WABot</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    max-width: 900px; margin: 0 auto; padding: 1rem;
    background: #f5f5f5; color: #333;
  }
  h1, h2 { margin-top: 0; }
  a { color: #0066cc; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  th, td { padding: .75rem 1rem; text-align: left; border-bottom: 1px solid #eee; }
  th { background: #f8f8f8; font-weight: 600; }
  .card { background: #fff; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  label { display: block; font-weight: 600; margin: .75rem 0 .25rem; }
  input[type="text"], input[type="number"], textarea, select {
    width: 100%; padding: .5rem; border: 1px solid #ccc; border-radius: 4px; font-size: .9rem;
  }
  textarea { min-height: 320px; font-family: monospace; resize: vertical; }
  button, .btn {
    display: inline-block; padding: .5rem 1.25rem; border: none; border-radius: 4px;
    font-size: .9rem; cursor: pointer; text-decoration: none; color: #fff;
  }
  .btn-primary { background: #0066cc; }
  .btn-primary:hover { background: #0055aa; }
  .btn-danger { background: #cc3333; }
  .btn-danger:hover { background: #aa2222; }
  .btn-secondary { background: #666; }
  .btn-secondary:hover { background: #555; }
  .badge { display: inline-block; padding: .15rem .5rem; border-radius: 10px; font-size: .75rem; font-weight: 600; }
  .badge-green { background: #d4edda; color: #155724; }
  .badge-gray { background: #e2e3e5; color: #383d41; }
  .flash { padding: 1rem; border-radius: 6px; margin-bottom: 1rem; }
  .flash-success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
  .flash-error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
  .masked { color: #999; font-style: italic; }
  .group-link { font-size: .8rem; color: #888; word-break: break-all; }
  .checkbox-row { display: flex; align-items: center; gap: .5rem; margin: .75rem 0; }
  .checkbox-row input[type="checkbox"] { width: auto; }
  .checkbox-row label { display: inline; margin: 0; }
  .nav { margin-bottom: 1rem; }
  .nav a { margin-right: 1rem; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export function renderAdminDashboard(config: AppConfig, adminToken: string): string {
  const rows = config.groups.map((g) => {
    const name = esc(g.name ?? g.jid);
    const hasEvents = g.events ? '<span class="badge badge-green">events</span>' : '';
    const chatbotActive = g.chatbot && g.chatbot.enabled !== false;
    const hasChatbot = chatbotActive ? '<span class="badge badge-green">chatbot</span>' : '';
    const noneLabel = !g.events && !chatbotActive ? '<span class="badge badge-gray">none</span>' : '';
    const groupUrl = g.webToken ? `/group/${esc(g.webToken)}` : '';
    const groupLink = groupUrl
      ? `<div class="group-link">Per-group link: <a href="${groupUrl}">${groupUrl}</a></div>`
      : '';
    return `<tr>
      <td>${name}<br><small style="color:#888">${esc(g.jid)}</small>${groupLink}</td>
      <td>${hasEvents} ${hasChatbot} ${noneLabel}</td>
      <td><a href="/admin/group/${encodeURIComponent(g.jid)}?token=${esc(adminToken)}" class="btn btn-primary">Edit</a></td>
    </tr>`;
  }).join('\n');

  const body = `
    <h1>WABot Admin</h1>
    <div class="nav">
      <a href="/admin/global?token=${esc(adminToken)}">Global Settings</a>
    </div>
    <table>
      <thead><tr><th>Group</th><th>Features</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  return renderLayout('Admin Dashboard', body);
}

export function renderAdminGlobalEdit(config: AppConfig, adminToken: string): string {
  const g = config.global;
  const body = `
    <h1>Global Settings</h1>
    <div class="nav">
      <a href="/admin?token=${esc(adminToken)}">&larr; Back to Dashboard</a>
    </div>
    <div class="card">
      <form method="POST" action="/admin/global?token=${esc(adminToken)}">
        <label>Claude Model</label>
        <input type="text" name="claudeModel" value="${esc(g.claudeModel)}">

        <label>Claude Max Tokens</label>
        <input type="number" name="claudeMaxTokens" value="${g.claudeMaxTokens}" min="1">

        <label>Gemini Image Model</label>
        <input type="text" name="geminiImageModel" value="${esc(g.geminiImageModel)}">

        <label>Anthropic API Key</label>
        <p class="masked">${g.anthropicApiKey ? 'Set (from environment)' : 'Not set'}</p>

        <label>Gemini API Key</label>
        <p class="masked">${g.geminiApiKey ? 'Set (from environment)' : 'Not set'}</p>

        <label>Google Service Account</label>
        <p class="masked">${g.googleServiceAccountEmail ? 'Set (from environment)' : 'Not set'}</p>

        <label>Google Private Key</label>
        <p class="masked">${g.googlePrivateKey ? 'Set (from environment)' : 'Not set'}</p>

        <br>
        <button type="submit" class="btn btn-primary">Save</button>
      </form>
    </div>`;

  return renderLayout('Global Settings', body);
}

export function renderAdminGroupEdit(group: GroupConfig, adminToken: string, baseUrl: string): string {
  const chatbot = group.chatbot;
  const events = group.events;
  const groupUrl = group.webToken ? `${baseUrl}/group/${group.webToken}` : '';

  const body = `
    <h1>Edit: ${esc(group.name ?? group.jid)}</h1>
    <div class="nav">
      <a href="/admin?token=${esc(adminToken)}">&larr; Back to Dashboard</a>
    </div>

    ${groupUrl ? `<div class="card">
      <h2>Per-Group Shareable Link</h2>
      <p style="word-break:break-all"><a href="${esc(groupUrl)}">${esc(groupUrl)}</a></p>
      <form method="POST" action="/admin/group/${encodeURIComponent(group.jid)}/regenerate-token?token=${esc(adminToken)}" style="display:inline">
        <button type="submit" class="btn btn-danger" onclick="return confirm('Regenerate token? The old link will stop working.')">Regenerate Token</button>
      </form>
    </div>` : ''}

    <div class="card">
      <h2>Chatbot Settings</h2>
      <form method="POST" action="/admin/group/${encodeURIComponent(group.jid)}?token=${esc(adminToken)}">

        <div class="checkbox-row">
          <input type="checkbox" id="chatbotEnabled" name="chatbotEnabled" value="1" ${chatbot && chatbot.enabled !== false ? 'checked' : ''}>
          <label for="chatbotEnabled">Enable Chatbot</label>
        </div>

        <label>Bot Name</label>
        <input type="text" name="botName" value="${esc(chatbot?.botName ?? '')}">

        <label>System Prompt</label>
        <textarea name="systemPrompt">${esc(chatbot?.systemPrompt ?? '')}</textarea>

        <div class="checkbox-row">
          <input type="checkbox" id="enableThinking" name="enableThinking" value="1" ${chatbot?.enableThinking ? 'checked' : ''}>
          <label for="enableThinking">Enable Thinking</label>
        </div>

        <label>Thinking Budget (tokens)</label>
        <input type="number" name="thinkingBudget" value="${chatbot?.thinkingBudget ?? 2000}" min="1">

        <div class="checkbox-row">
          <input type="checkbox" id="enableWebSearch" name="enableWebSearch" value="1" ${chatbot?.enableWebSearch ? 'checked' : ''}>
          <label for="enableWebSearch">Enable Web Search</label>
        </div>

        <label>Max Searches</label>
        <input type="number" name="maxSearches" value="${chatbot?.maxSearches ?? 3}" min="1">

        <label>Hotness (0-100)</label>
        <input type="number" name="hotness" value="${chatbot?.hotness ?? 35}" min="0" max="100">

        <label>Max Replies Per Window</label>
        <input type="number" name="responseRateLimitCount" value="${chatbot?.responseRateLimitCount ?? 5}" min="1">

        <label>Rate Limit Window (seconds)</label>
        <input type="number" name="responseRateLimitWindowSec" value="${chatbot?.responseRateLimitWindowSec ?? 60}" min="1">

        <div class="checkbox-row">
          <input type="checkbox" id="responseRateLimitWarn" name="responseRateLimitWarn" value="1" ${chatbot?.responseRateLimitWarn !== false ? 'checked' : ''}>
          <label for="responseRateLimitWarn">Send one cooldown warning</label>
        </div>

        <div class="checkbox-row">
          <input type="checkbox" id="enableImageGeneration" name="enableImageGeneration" value="1" ${chatbot?.enableImageGeneration !== false ? 'checked' : ''}>
          <label for="enableImageGeneration">Allow image generation on direct requests</label>
        </div>

        <div class="checkbox-row">
          <input type="checkbox" id="enableAutoImageReplies" name="enableAutoImageReplies" value="1" ${chatbot?.enableAutoImageReplies ? 'checked' : ''}>
          <label for="enableAutoImageReplies">Allow automatic image replies</label>
        </div>

        <h2 style="margin-top:1.5rem">Events Settings</h2>

        <div class="checkbox-row">
          <input type="checkbox" id="eventsEnabled" name="eventsEnabled" value="1" ${events ? 'checked' : ''}>
          <label for="eventsEnabled">Enable Events</label>
        </div>

        <label>Spreadsheet ID</label>
        <input type="text" name="spreadsheetId" value="${esc(events?.spreadsheetId ?? '')}">

        <label>Sheet Name</label>
        <input type="text" name="sheetName" value="${esc(events?.sheetName ?? 'Sheet1')}">

        <label>Message Template</label>
        <textarea name="messageTemplate">${esc(events?.messageTemplate ?? '')}</textarea>

        <label>Cron Schedule</label>
        <input type="text" name="cronSchedule" value="${esc(events?.cronSchedule ?? '0 8 * * *')}">

        <br><br>
        <button type="submit" class="btn btn-primary">Save</button>
      </form>
    </div>`;

  return renderLayout(`Edit ${group.name ?? group.jid}`, body);
}

export function renderGroupEdit(group: GroupConfig, saved?: boolean): string {
  const chatbot = group.chatbot;
  const body = `
    <h1>${esc(group.name ?? group.jid)} - Chatbot Settings</h1>

    ${saved ? '<div class="flash flash-success">Settings saved successfully.</div>' : ''}

    <div class="card">
      <form method="POST">
        <label>Bot Name</label>
        <input type="text" name="botName" value="${esc(chatbot?.botName ?? '')}">

        <label>System Prompt</label>
        <textarea name="systemPrompt">${esc(chatbot?.systemPrompt ?? '')}</textarea>

        <div class="checkbox-row">
          <input type="checkbox" id="enableThinking" name="enableThinking" value="1" ${chatbot?.enableThinking ? 'checked' : ''}>
          <label for="enableThinking">Enable Thinking</label>
        </div>

        <label>Thinking Budget (tokens)</label>
        <input type="number" name="thinkingBudget" value="${chatbot?.thinkingBudget ?? 2000}" min="1">

        <div class="checkbox-row">
          <input type="checkbox" id="enableWebSearch" name="enableWebSearch" value="1" ${chatbot?.enableWebSearch ? 'checked' : ''}>
          <label for="enableWebSearch">Enable Web Search</label>
        </div>

        <label>Max Searches</label>
        <input type="number" name="maxSearches" value="${chatbot?.maxSearches ?? 3}" min="1">

        <label>Hotness (0-100)</label>
        <input type="number" name="hotness" value="${chatbot?.hotness ?? 35}" min="0" max="100">

        <label>Max Replies Per Window</label>
        <input type="number" name="responseRateLimitCount" value="${chatbot?.responseRateLimitCount ?? 5}" min="1">

        <label>Rate Limit Window (seconds)</label>
        <input type="number" name="responseRateLimitWindowSec" value="${chatbot?.responseRateLimitWindowSec ?? 60}" min="1">

        <div class="checkbox-row">
          <input type="checkbox" id="responseRateLimitWarn" name="responseRateLimitWarn" value="1" ${chatbot?.responseRateLimitWarn !== false ? 'checked' : ''}>
          <label for="responseRateLimitWarn">Send one cooldown warning</label>
        </div>

        <div class="checkbox-row">
          <input type="checkbox" id="enableImageGeneration" name="enableImageGeneration" value="1" ${chatbot?.enableImageGeneration !== false ? 'checked' : ''}>
          <label for="enableImageGeneration">Allow image generation on direct requests</label>
        </div>

        <div class="checkbox-row">
          <input type="checkbox" id="enableAutoImageReplies" name="enableAutoImageReplies" value="1" ${chatbot?.enableAutoImageReplies ? 'checked' : ''}>
          <label for="enableAutoImageReplies">Allow automatic image replies</label>
        </div>

        <br><br>
        <button type="submit" class="btn btn-primary">Save</button>
      </form>
    </div>`;

  return renderLayout(`${group.name ?? group.jid} Settings`, body);
}

export function renderSuccess(message: string, backUrl: string): string {
  const body = `
    <div class="flash flash-success">${esc(message)}</div>
    <a href="${esc(backUrl)}" class="btn btn-secondary">&larr; Back</a>`;
  return renderLayout('Success', body);
}

export function renderError(message: string): string {
  const body = `
    <div class="flash flash-error">${esc(message)}</div>
    <a href="javascript:history.back()" class="btn btn-secondary">&larr; Go Back</a>`;
  return renderLayout('Error', body);
}
