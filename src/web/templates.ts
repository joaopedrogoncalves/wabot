import type { AppConfig, ChatModelConfig, GlobalConfig, GroupConfig, ScheduledPostJobConfig } from '../config.js';
import { getAllowedChatModels, resolveGroupChatModel } from '../config.js';

export type ManualActionJobView = {
  id: string;
  action: 'send-message' | 'generate-image' | 'generate-video' | 'send-next-event';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  stage: string;
  promptPreview: string;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

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
  .badge-blue { background: #d1ecf1; color: #0c5460; }
  .badge-red { background: #f8d7da; color: #721c24; }
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
  .muted { color: #666; font-size: .9rem; }
  .scheduled-job-list { display: flex; flex-direction: column; gap: 1rem; margin-top: 1rem; }
  .scheduled-job { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; background: #fafafa; }
  .scheduled-job-header { display: flex; justify-content: space-between; align-items: center; gap: .75rem; margin-bottom: .75rem; }
  .scheduled-job-title { font-size: 1rem; font-weight: 600; margin: 0; }
  .field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
  .field-grid > div label:first-child { margin-top: 0; }
  .textarea-compact { min-height: 140px; }
  .textarea-short { min-height: 110px; }
  .empty-state { padding: 1rem; border: 1px dashed #bbb; border-radius: 8px; background: #fafafa; color: #666; }
  .action-section { border-top: 1px solid #eee; margin-top: 1.25rem; padding-top: 1rem; }
  .action-section:first-of-type { border-top: none; margin-top: 0; padding-top: 0; }
  .manual-job-list { display: flex; flex-direction: column; gap: .75rem; margin-top: .75rem; }
  .manual-job { border: 1px solid #ddd; border-radius: 8px; padding: .85rem; background: #fafafa; }
  .manual-job-header { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
  .manual-job-title { font-weight: 600; }
  .manual-job p { margin: .35rem 0 0; }
  .manual-job code { overflow-wrap: anywhere; white-space: normal; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function renderScheduledPostCard(
  prefix: string,
  index: number,
  job?: ScheduledPostJobConfig,
): string {
  return `<div class="scheduled-job" data-scheduled-job>
    <div class="scheduled-job-header">
      <p class="scheduled-job-title">Scheduled Job <span data-job-number>${index + 1}</span></p>
      <button type="button" class="btn btn-danger" data-remove-scheduled-job>Remove</button>
    </div>

    <div class="checkbox-row">
      <input type="checkbox" id="${prefix}-enabled-${index}" name="${prefix}Enabled_${index}" value="1" ${job?.enabled !== false ? 'checked' : ''}>
      <label for="${prefix}-enabled-${index}">Enabled</label>
    </div>

    <div class="field-grid">
      <div>
        <label>Label</label>
        <input type="text" name="${prefix}Label_${index}" value="${esc(job?.label ?? '')}" placeholder="morning-news-roundup">
      </div>
      <div>
        <label>Cron Schedule</label>
        <input type="text" name="${prefix}CronSchedule_${index}" value="${esc(job?.cronSchedule ?? '')}" placeholder="0 8 * * *">
      </div>
      <div>
        <label>Lookback Hours</label>
        <input type="number" name="${prefix}LookbackHours_${index}" value="${job?.lookbackHours ?? 24}" min="1" max="168">
      </div>
      <div>
        <label>Max Searches</label>
        <input type="number" name="${prefix}MaxSearches_${index}" value="${job?.maxSearches ?? 3}" min="1" max="10">
      </div>
    </div>

    <div class="checkbox-row">
      <input type="checkbox" id="${prefix}-web-${index}" name="${prefix}EnableWebSearch_${index}" value="1" ${job?.enableWebSearch ? 'checked' : ''}>
      <label for="${prefix}-web-${index}">Enable web search for this job</label>
    </div>

    <label>Prompt</label>
    <textarea class="textarea-compact" name="${prefix}Prompt_${index}" placeholder="Every morning, review the last day of discussion, search the web when useful, and post an image-led roundup.">${esc(job?.prompt ?? '')}</textarea>
  </div>`;
}

function renderModelAllowlistEditor(config: AppConfig, group: GroupConfig): string {
  const chatbot = group.chatbot;
  const allowedIds = new Set((chatbot?.allowedModelIds ?? []).map((id) => id.toLowerCase()));
  const defaultModelId = chatbot?.defaultModelId ?? '';
  const activeModel = chatbot ? resolveGroupChatModel(config.global, group) : null;

  const checkboxes = config.global.chatModels.map((model) => {
    const checked = allowedIds.has(model.id.toLowerCase());
    const capabilities = [
      model.provider,
      ...(model.supportsWebSearch ? ['search'] : []),
      ...(model.supportsThinking ? ['thinking'] : []),
    ];
    return `<div class="checkbox-row">
      <input type="checkbox" id="allowedModel-${esc(model.id)}" name="allowedModelIds" value="${esc(model.id)}" ${checked ? 'checked' : ''}>
      <label for="allowedModel-${esc(model.id)}">${esc(model.id)} — ${esc(model.label)} <span class="muted">[${esc(capabilities.join(', '))}]</span></label>
    </div>`;
  }).join('');

  const defaultOptions = config.global.chatModels.map((model) =>
    `<option value="${esc(model.id)}" ${defaultModelId.toLowerCase() === model.id.toLowerCase() ? 'selected' : ''}>${esc(model.id)} — ${esc(model.label)}</option>`
  ).join('');

  return `
    <h2 style="margin-top:1.5rem">Chat Models</h2>
    <p class="muted">Admins choose which reply models the group can use. Participants can then switch among the allowed ones with <code>/model</code>.</p>
    ${checkboxes}
    <label>Default Model</label>
    <select name="defaultModelId">${defaultOptions}</select>
    ${activeModel ? `<p class="muted">Current active model: <strong>${esc(activeModel.id)} — ${esc(activeModel.label)}</strong></p>` : ''}
  `;
}

function renderScheduledPostsEditor(group: GroupConfig, editorId: string): string {
  const jobs = group.scheduledPosts ?? [];
  const cardsHtml = jobs.map((job, index) => renderScheduledPostCard('scheduledPost', index, job)).join('');
  const emptyStateId = `${editorId}-empty`;
  const listId = `${editorId}-list`;
  const countId = `${editorId}-count`;
  const addButtonId = `${editorId}-add`;
  const template = renderScheduledPostCard('scheduledPost', 0);

  return `
    <p class="muted">Create autonomous image posts that run on a cron schedule using recent chat context.</p>
    <p class="muted">Cron uses the server timezone. If image generation fails, the bot falls back to caption-only.</p>
    <input type="hidden" name="scheduledPostCount" id="${esc(countId)}" value="${jobs.length}">
    <div id="${esc(emptyStateId)}" class="empty-state" ${jobs.length > 0 ? 'style="display:none"' : ''}>No scheduled jobs configured yet.</div>
    <div id="${esc(listId)}" class="scheduled-job-list">${cardsHtml}</div>
    <button type="button" id="${esc(addButtonId)}" class="btn btn-secondary">Add Scheduled Job</button>
    <template id="${esc(editorId)}-template">${template}</template>
    <script>
      (() => {
        const list = document.getElementById(${JSON.stringify(listId)});
        const emptyState = document.getElementById(${JSON.stringify(emptyStateId)});
        const countInput = document.getElementById(${JSON.stringify(countId)});
        const addButton = document.getElementById(${JSON.stringify(addButtonId)});
        const template = document.getElementById(${JSON.stringify(`${editorId}-template`)});
        const form = addButton?.closest('form');

        if (!list || !emptyState || !countInput || !addButton || !template || !form) return;

        function renumber() {
          const jobs = Array.from(list.querySelectorAll('[data-scheduled-job]'));
          jobs.forEach((job, index) => {
            job.querySelectorAll('input, textarea').forEach((field) => {
              if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) return;
              const currentName = field.getAttribute('name');
              if (currentName) {
                field.setAttribute('name', currentName.replace(/_\\d+$/, '_' + index));
              }

              const currentId = field.getAttribute('id');
              if (currentId) {
                field.setAttribute('id', currentId.replace(/-\\d+$/, '-' + index));
              }
            });

            job.querySelectorAll('label[for]').forEach((label) => {
              const currentFor = label.getAttribute('for');
              if (currentFor) {
                label.setAttribute('for', currentFor.replace(/-\\d+$/, '-' + index));
              }
            });

            const number = job.querySelector('[data-job-number]');
            if (number) number.textContent = String(index + 1);
          });

          countInput.value = String(jobs.length);
          emptyState.style.display = jobs.length > 0 ? 'none' : 'block';
        }

        function wireCard(card) {
          const removeButton = card.querySelector('[data-remove-scheduled-job]');
          if (removeButton) {
            removeButton.addEventListener('click', () => {
              card.remove();
              renumber();
            });
          }
        }

        function addCard() {
          const wrapper = document.createElement('div');
          wrapper.innerHTML = template.innerHTML.trim();
          const card = wrapper.firstElementChild;
          if (!card) return;
          list.appendChild(card);
          wireCard(card);
          renumber();
        }

        Array.from(list.querySelectorAll('[data-scheduled-job]')).forEach(wireCard);
        addButton.addEventListener('click', addCard);
        form.addEventListener('submit', renumber);
        renumber();
      })();
    </script>`;
}

function getManualActionLabel(action: ManualActionJobView['action']): string {
  if (action === 'send-message') return 'Message';
  if (action === 'generate-image') return 'Image';
  if (action === 'send-next-event') return 'Event';
  return 'Video';
}

function getManualStatusBadge(job: ManualActionJobView): string {
  if (job.status === 'succeeded') return '<span class="badge badge-green">sent</span>';
  if (job.status === 'failed') return '<span class="badge badge-red">failed</span>';
  if (job.status === 'queued') return '<span class="badge badge-gray">queued</span>';
  return '<span class="badge badge-blue">running</span>';
}

function formatTimestamp(timestamp: number | undefined): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString();
}

function renderManualJobStatus(jobs: ManualActionJobView[]): string {
  const hasActiveJob = jobs.some((job) => job.status === 'queued' || job.status === 'running');
  const jobRows = jobs.length === 0
    ? '<div class="empty-state">No manual posts have run since the last restart.</div>'
    : `<div class="manual-job-list">${jobs.map((job) => {
      const finalLine = job.status === 'failed' && job.error
        ? `<p class="flash flash-error" style="margin-top:.5rem;padding:.6rem">${esc(job.error)}</p>`
        : job.result
          ? `<p class="muted">${esc(job.result)}</p>`
          : '';
      return `<div class="manual-job">
        <div class="manual-job-header">
          <span class="manual-job-title">${esc(getManualActionLabel(job.action))} post</span>
          ${getManualStatusBadge(job)}
        </div>
        <p>${esc(job.stage)}</p>
        <p class="muted">Started ${esc(formatTimestamp(job.createdAt))}${job.completedAt ? `; finished ${esc(formatTimestamp(job.completedAt))}` : ''}</p>
        <p class="muted"><code>${esc(job.promptPreview)}</code></p>
        ${finalLine}
      </div>`;
    }).join('')}</div>`;

  return `<div class="action-section">
    <h3 style="margin:0 0 .5rem">Manual Post Status</h3>
    <p class="muted">This shows recent manual posts for this group. Status resets when the bot restarts.</p>
    ${jobRows}
    ${hasActiveJob ? `<p class="muted">Refreshing while work is active.</p>
    <script>
      (() => {
        setTimeout(() => {
          const active = document.activeElement;
          const tag = active?.tagName?.toLowerCase();
          if (tag === 'textarea' || tag === 'input' || tag === 'select') return;
          window.location.reload();
        }, 5000);
      })();
    </script>` : ''}
  </div>`;
}

function renderManualGroupActions(actionUrl: string, jobs: ManualActionJobView[] = []): string {
  return `<div class="card">
    <h2>Post To Group</h2>
    <p class="muted">Send an exact message, or give the bot a prompt and let it generate an image or video post in this group persona.</p>

    ${renderManualJobStatus(jobs)}

    <div class="action-section">
      <form method="POST" action="${esc(actionUrl)}">
        <input type="hidden" name="action" value="send-message">
        <label>Send exact message</label>
        <textarea class="textarea-short" name="text" maxlength="4000" placeholder="Write the message to send as the bot."></textarea>
        <br><br>
        <button type="submit" class="btn btn-primary">Send Message</button>
      </form>
    </div>

    <div class="action-section">
      <form method="POST" action="${esc(actionUrl)}">
        <input type="hidden" name="action" value="generate-image">
        <label>Generate image post</label>
        <textarea class="textarea-short" name="prompt" maxlength="5000" placeholder="Describe the image post you want. The bot will write the caption and visual prompt in the group persona."></textarea>
        <br><br>
        <button type="submit" class="btn btn-primary">Generate Image</button>
      </form>
    </div>

    <div class="action-section">
      <form method="POST" action="${esc(actionUrl)}">
        <input type="hidden" name="action" value="generate-video">
        <label>Generate video post</label>
        <textarea class="textarea-short" name="prompt" maxlength="5000" placeholder="Describe the video post you want. The bot will write the caption and Veo prompt in the group persona."></textarea>
        <p class="muted">Video generation runs in the background and posts when ready.</p>
        <button type="submit" class="btn btn-primary">Generate Video</button>
      </form>
    </div>
  </div>`;
}

export function renderAdminDashboard(config: AppConfig, adminToken: string): string {
  const rows = config.groups.map((g) => {
    const name = esc(g.name ?? g.jid);
    const hasEvents = g.events ? '<span class="badge badge-green">events</span>' : '';
    const hasEventImages = g.events?.enableImageAnnouncements ? '<span class="badge badge-green">event images</span>' : '';
    const chatbotActive = g.chatbot && g.chatbot.enabled !== false;
    const hasChatbot = chatbotActive ? '<span class="badge badge-green">chatbot</span>' : '';
    const scheduledActive = (g.scheduledPosts?.some((job) => job.enabled !== false)) ?? false;
    const hasScheduled = scheduledActive ? '<span class="badge badge-green">scheduled</span>' : '';
    const noneLabel = !g.events && !chatbotActive && !scheduledActive ? '<span class="badge badge-gray">none</span>' : '';
    const groupUrl = g.webToken ? `/group/${esc(g.webToken)}` : '';
    const groupLink = groupUrl
      ? `<div class="group-link">Per-group link: <a href="${groupUrl}">${groupUrl}</a></div>`
      : '';
    return `<tr>
      <td>${name}<br><small style="color:#888">${esc(g.jid)}</small>${groupLink}</td>
      <td>${hasEvents} ${hasEventImages} ${hasChatbot} ${hasScheduled} ${noneLabel}</td>
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
  const modelRows = g.chatModels.map((model) => {
    const capabilities = [
      model.provider,
      ...(model.supportsWebSearch ? ['search'] : []),
      ...(model.supportsThinking ? ['thinking'] : []),
    ];
    return `<tr>
      <td><code>${esc(model.id)}</code></td>
      <td>${esc(model.label)}</td>
      <td><code>${esc(model.apiModel)}</code></td>
      <td>${esc(capabilities.join(', '))}</td>
    </tr>`;
  }).join('');
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

        <label>Gemini Video Model</label>
        <input type="text" name="geminiVideoModel" value="${esc(g.geminiVideoModel)}">

        <label>Chat Max Output Tokens</label>
        <input type="number" name="chatMaxOutputTokens" value="${g.chatMaxOutputTokens}" min="1">

        <h2 style="margin-top:1.5rem">Chat Model Catalog</h2>
        <p class="muted">The catalog is config-defined. These are the currently loaded model ids available to group admins.</p>
        <table>
          <thead><tr><th>ID</th><th>Label</th><th>API Model</th><th>Capabilities</th></tr></thead>
          <tbody>${modelRows}</tbody>
        </table>

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

export function renderAdminGroupEdit(
  config: AppConfig,
  group: GroupConfig,
  adminToken: string,
  baseUrl: string,
  manualJobs: ManualActionJobView[] = [],
): string {
  const chatbot = group.chatbot;
  const events = group.events;
  const groupUrl = group.webToken ? `${baseUrl}/group/${group.webToken}` : '';
  const sendNextEventFormId = `send-next-event-${group.jid.replace(/[^a-z0-9_-]/gi, '-')}`;
  const sendNextEventAction = `/admin/group/${encodeURIComponent(group.jid)}/action?token=${esc(adminToken)}`;

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

    ${renderManualGroupActions(`/admin/group/${encodeURIComponent(group.jid)}/action?token=${adminToken}`, manualJobs)}
    ${events ? `<form id="${esc(sendNextEventFormId)}" method="POST" action="${sendNextEventAction}" style="display:none">
      <input type="hidden" name="action" value="send-next-event">
    </form>` : ''}

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

        ${renderModelAllowlistEditor(config, group)}

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
          <input type="checkbox" id="enableVideoGeneration" name="enableVideoGeneration" value="1" ${chatbot?.enableVideoGeneration !== false ? 'checked' : ''}>
          <label for="enableVideoGeneration">Allow video generation on direct requests</label>
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

        <div class="checkbox-row">
          <input type="checkbox" id="enableEventImageAnnouncements" name="enableEventImageAnnouncements" value="1" ${events?.enableImageAnnouncements ? 'checked' : ''}>
          <label for="enableEventImageAnnouncements">Send event announcements with generated images</label>
        </div>

        ${events ? `<button type="submit" form="${esc(sendNextEventFormId)}" class="btn btn-secondary">Send next event message now</button>
        <p class="muted">Uses the next upcoming row in the sheet and respects the generated-image setting above after it has been saved.</p>` : '<p class="muted">Save events settings before sending a test event message.</p>'}

        <h2 style="margin-top:1.5rem">Scheduled Posts</h2>
        ${renderScheduledPostsEditor(group, 'admin-scheduled-posts')}

        <br><br>
        <button type="submit" class="btn btn-primary">Save</button>
      </form>
    </div>`;

  return renderLayout(`Edit ${group.name ?? group.jid}`, body);
}

export function renderGroupEdit(
  config: AppConfig,
  group: GroupConfig,
  saved?: boolean,
  manualJobs: ManualActionJobView[] = [],
): string {
  const chatbot = group.chatbot;
  const allowedModels = chatbot ? getAllowedChatModels(config.global, group) : [];
  const activeModel = chatbot ? resolveGroupChatModel(config.global, group) : null;
  const actionUrl = group.webToken ? `/group/${group.webToken}/action` : '';
  const body = `
    <h1>${esc(group.name ?? group.jid)} - Chatbot Settings</h1>

    ${saved ? '<div class="flash flash-success">Settings saved successfully.</div>' : ''}

    ${actionUrl ? renderManualGroupActions(actionUrl, manualJobs) : ''}

    <div class="card">
      <form method="POST">
        <label>Bot Name</label>
        <input type="text" name="botName" value="${esc(chatbot?.botName ?? '')}">

        <label>System Prompt</label>
        <textarea name="systemPrompt">${esc(chatbot?.systemPrompt ?? '')}</textarea>

        ${activeModel ? `<p class="muted">Current model: <strong>${esc(activeModel.id)} — ${esc(activeModel.label)}</strong></p>` : ''}
        ${allowedModels.length > 0 ? `<p class="muted">Allowed models: ${allowedModels.map((model) => `${esc(model.id)} — ${esc(model.label)}`).join(', ')}. Use <code>/model</code> in chat to switch.</p>` : ''}

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
          <input type="checkbox" id="enableVideoGeneration" name="enableVideoGeneration" value="1" ${chatbot?.enableVideoGeneration !== false ? 'checked' : ''}>
          <label for="enableVideoGeneration">Allow video generation on direct requests</label>
        </div>

        <div class="checkbox-row">
          <input type="checkbox" id="enableAutoImageReplies" name="enableAutoImageReplies" value="1" ${chatbot?.enableAutoImageReplies ? 'checked' : ''}>
          <label for="enableAutoImageReplies">Allow automatic image replies</label>
        </div>

        <h2 style="margin-top:1.5rem">Scheduled Posts</h2>
        ${renderScheduledPostsEditor(group, 'group-scheduled-posts')}

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
