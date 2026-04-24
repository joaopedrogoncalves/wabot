import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'crypto';
import type { ConfigHolder } from '../config.js';
import type { GroupConfig } from '../config.js';
import { updateConfigFile } from '../config.js';
import { sendNextEventMessageNow, startEventCrons, startScheduledPostCrons } from '../cron.js';
import { generateImage } from '../gemini.js';
import { cleanupGeneratedVideo, generateVideo } from '../gemini-video.js';
import { generateManualImagePost, generateManualVideoPost } from '../llm.js';
import { sendGroupImageMessage, sendGroupMessage, sendGroupVideoMessage } from '../whatsapp.js';
import {
  renderAdminDashboard,
  renderAdminGlobalEdit,
  renderAdminGroupEdit,
  renderGroupEdit,
  renderSuccess,
  renderError,
  type ManualActionJobView,
} from './templates.js';

type ManualGroupAction = 'send-message' | 'generate-image' | 'generate-video' | 'send-next-event';
type ManualActionJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
type ManualActionJob = ManualActionJobView & {
  groupJid: string;
};

const MANUAL_ACTION_TEXT_MAX_CHARS = 4_000;
const MANUAL_ACTION_PROMPT_MAX_CHARS = 5_000;
const MANUAL_ACTION_HISTORY_LIMIT = 12;

const manualActionJobsByGroup = new Map<string, ManualActionJob[]>();

function getTrimmedString(rawValue: unknown): string {
  return typeof rawValue === 'string' ? rawValue.trim() : '';
}

function parsePositiveInt(rawValue: unknown, fieldName: string, options?: { min?: number; max?: number }): number | undefined {
  const text = getTrimmedString(rawValue);
  if (!text) return undefined;

  const value = parseInt(text, 10);
  if (Number.isNaN(value)) {
    throw new Error(`${fieldName} must be a number.`);
  }

  if (options?.min !== undefined && value < options.min) {
    throw new Error(`${fieldName} must be at least ${options.min}.`);
  }

  if (options?.max !== undefined && value > options.max) {
    throw new Error(`${fieldName} must be at most ${options.max}.`);
  }

  return value;
}

function parseScheduledPostsForm(body: Record<string, unknown>): any[] {
  const count = parsePositiveInt(body.scheduledPostCount, 'Scheduled post count', { min: 0, max: 100 }) ?? 0;
  const jobs: any[] = [];

  for (let index = 0; index < count; index += 1) {
    const label = getTrimmedString(body[`scheduledPostLabel_${index}`]);
    const cronSchedule = getTrimmedString(body[`scheduledPostCronSchedule_${index}`]);
    const prompt = getTrimmedString(body[`scheduledPostPrompt_${index}`]);
    const lookbackHours = parsePositiveInt(body[`scheduledPostLookbackHours_${index}`], `Scheduled post ${index + 1} lookback hours`, { min: 1, max: 168 });
    const maxSearches = parsePositiveInt(body[`scheduledPostMaxSearches_${index}`], `Scheduled post ${index + 1} max searches`, { min: 1, max: 10 });
    const enabled = body[`scheduledPostEnabled_${index}`] === '1';
    const enableWebSearch = body[`scheduledPostEnableWebSearch_${index}`] === '1';
    const hasContent = !!(label || cronSchedule || prompt || lookbackHours !== undefined || maxSearches !== undefined || enabled || enableWebSearch);

    if (!hasContent) continue;
    if (!cronSchedule) throw new Error(`Scheduled post ${index + 1} is missing a cron schedule.`);
    if (!prompt) throw new Error(`Scheduled post ${index + 1} is missing a prompt.`);

    jobs.push({
      enabled,
      label,
      cronSchedule,
      prompt,
      lookbackHours,
      enableWebSearch,
      maxSearches,
    });
  }

  return jobs;
}

function parseScheduledPosts(rawValue: unknown, body: Record<string, unknown>): any[] {
  if (body.scheduledPostCount !== undefined) {
    return parseScheduledPostsForm(body);
  }

  const text = getTrimmedString(rawValue);
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid scheduled posts JSON: ${err}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Scheduled posts JSON must be an array.');
  }

  return parsed;
}

function parseSelectedModelIds(rawValue: unknown): string[] {
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((value) => getTrimmedString(value))
      .filter(Boolean);
  }

  const single = getTrimmedString(rawValue);
  return single ? [single] : [];
}

function parseManualGroupAction(rawValue: unknown): ManualGroupAction {
  const action = getTrimmedString(rawValue);
  if (action === 'send-message' || action === 'generate-image' || action === 'generate-video' || action === 'send-next-event') {
    return action;
  }
  throw new Error('Invalid group action.');
}

function getRequiredText(rawValue: unknown, fieldName: string, maxChars: number): string {
  const text = getTrimmedString(rawValue);
  if (!text) {
    throw new Error(`${fieldName} is required.`);
  }
  if (text.length > maxChars) {
    throw new Error(`${fieldName} must be ${maxChars} characters or fewer.`);
  }
  return text;
}

function findFreshGroup(configHolder: ConfigHolder, groupJid: string): GroupConfig {
  const group = configHolder.current.groups.find((entry) => entry.jid === groupJid);
  if (!group) {
    throw new Error(`Group ${groupJid} is no longer configured.`);
  }
  return group;
}

function buildPromptPreview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 177).trimEnd()}...`;
}

function createManualActionJob(groupJid: string, action: ManualGroupAction, prompt: string): ManualActionJob {
  const now = Date.now();
  const job: ManualActionJob = {
    id: randomUUID(),
    groupJid,
    action,
    status: 'queued',
    stage: action === 'send-message'
      ? 'Waiting to send message.'
      : action === 'send-next-event'
        ? 'Waiting to send next event message.'
        : 'Waiting to start generation.',
    promptPreview: buildPromptPreview(prompt),
    createdAt: now,
    updatedAt: now,
  };

  const jobs = manualActionJobsByGroup.get(groupJid) ?? [];
  jobs.unshift(job);
  if (jobs.length > MANUAL_ACTION_HISTORY_LIMIT) {
    jobs.splice(MANUAL_ACTION_HISTORY_LIMIT);
  }
  manualActionJobsByGroup.set(groupJid, jobs);
  return job;
}

function updateManualActionJob(
  groupJid: string,
  jobId: string,
  patch: Partial<Omit<ManualActionJob, 'id' | 'groupJid' | 'action' | 'createdAt'>>,
): void {
  const job = manualActionJobsByGroup.get(groupJid)?.find((entry) => entry.id === jobId);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
}

function finishManualActionJob(
  groupJid: string,
  jobId: string,
  status: Extract<ManualActionJobStatus, 'succeeded' | 'failed'>,
  patch: Partial<Pick<ManualActionJob, 'stage' | 'result' | 'error'>>,
): void {
  updateManualActionJob(groupJid, jobId, {
    ...patch,
    status,
    completedAt: Date.now(),
  });
}

function getManualActionJobsForGroup(groupJid: string): ManualActionJobView[] {
  return (manualActionJobsByGroup.get(groupJid) ?? []).map((job) => ({
    id: job.id,
    action: job.action,
    status: job.status,
    stage: job.stage,
    promptPreview: job.promptPreview,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  }));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runManualTextAction(configHolder: ConfigHolder, groupJid: string, text: string, jobId: string): Promise<void> {
  const group = findFreshGroup(configHolder, groupJid);
  updateManualActionJob(groupJid, jobId, {
    status: 'running',
    stage: 'Sending message to WhatsApp.',
  });
  await sendGroupMessage(group.jid, text);
  finishManualActionJob(groupJid, jobId, 'succeeded', {
    stage: 'Message sent.',
    result: 'Posted exact message to the group.',
  });
}

async function runManualNextEventAction(configHolder: ConfigHolder, groupJid: string, jobId: string): Promise<void> {
  const group = findFreshGroup(configHolder, groupJid);
  const config = configHolder.current;
  updateManualActionJob(groupJid, jobId, {
    status: 'running',
    stage: 'Fetching the next configured event.',
  });
  const result = await sendNextEventMessageNow(config, group);
  finishManualActionJob(groupJid, jobId, 'succeeded', {
    stage: result.sentWithImage ? 'Next event image announcement sent.' : 'Next event message sent.',
    result: `Posted ${result.name} (${result.date}) to the group${result.sentWithImage ? ' with a generated image' : ''}.`,
  });
}

async function runManualImageAction(configHolder: ConfigHolder, groupJid: string, prompt: string, jobId: string): Promise<void> {
  const group = findFreshGroup(configHolder, groupJid);
  const config = configHolder.current;
  const groupLabel = group.name ?? group.jid;
  console.log(`[web-action] Generating manual image post for "${groupLabel}" promptChars=${prompt.length}`);
  updateManualActionJob(groupJid, jobId, {
    status: 'running',
    stage: 'Planning caption and image prompt.',
  });

  const post = await generateManualImagePost(config, group, group.jid, prompt);
  let generatedImage: Awaited<ReturnType<typeof generateImage>> = null;

  if (post.image?.prompt) {
    updateManualActionJob(groupJid, jobId, {
      status: 'running',
      stage: 'Generating image with Gemini.',
    });
    generatedImage = await generateImage(config.global, post.image.prompt, {
      latestUserText: prompt,
      replyText: post.caption,
      visualBrief: post.image.prompt,
      reason: 'manual web image action',
      literalness: post.image.literalness,
      mood: post.image.mood,
      style: post.image.style,
      keySubjects: post.image.keySubjects,
      mustAvoid: post.image.mustAvoid,
      textInImage: post.image.textInImage,
    });
  }

  updateManualActionJob(groupJid, jobId, {
    status: 'running',
    stage: 'Sending post to WhatsApp.',
  });
  if (generatedImage) {
    await sendGroupImageMessage(group.jid, generatedImage.data, generatedImage.mimeType, post.caption);
    finishManualActionJob(groupJid, jobId, 'succeeded', {
      stage: 'Image post sent.',
      result: 'Posted generated image and caption to the group.',
    });
    console.log(`[web-action] Sent manual image post to "${groupLabel}"`);
  } else {
    await sendGroupMessage(group.jid, post.caption);
    finishManualActionJob(groupJid, jobId, 'succeeded', {
      stage: 'Caption-only fallback sent.',
      result: 'Posted the generated caption because no image was returned.',
    });
    console.log(`[web-action] Sent manual image fallback text post to "${groupLabel}"`);
  }
}

async function runManualVideoAction(configHolder: ConfigHolder, groupJid: string, prompt: string, jobId: string): Promise<void> {
  const group = findFreshGroup(configHolder, groupJid);
  const config = configHolder.current;
  const groupLabel = group.name ?? group.jid;
  let generatedVideo: Awaited<ReturnType<typeof generateVideo>> = null;
  console.log(`[web-action] Generating manual video post for "${groupLabel}" promptChars=${prompt.length}`);
  updateManualActionJob(groupJid, jobId, {
    status: 'running',
    stage: 'Planning caption and video prompt.',
  });

  try {
    const post = await generateManualVideoPost(config, group, group.jid, prompt);
    if (!post.video?.prompt) {
      updateManualActionJob(groupJid, jobId, {
        status: 'running',
        stage: 'Sending caption-only fallback to WhatsApp.',
      });
      await sendGroupMessage(group.jid, post.caption);
      finishManualActionJob(groupJid, jobId, 'succeeded', {
        stage: 'Caption-only fallback sent.',
        result: 'Posted the generated caption because no video prompt was produced.',
      });
      console.log(`[web-action] Sent manual video fallback text post to "${groupLabel}" because no video prompt was produced`);
      return;
    }

    updateManualActionJob(groupJid, jobId, {
      status: 'running',
      stage: 'Generating video with Veo.',
    });
    generatedVideo = await generateVideo(config.global, post.video.prompt, {
      aspectRatio: post.video.aspectRatio,
      durationSeconds: post.video.durationSeconds,
      resolution: post.video.resolution,
    });

    updateManualActionJob(groupJid, jobId, {
      status: 'running',
      stage: 'Sending video to WhatsApp.',
    });
    if (generatedVideo) {
      await sendGroupVideoMessage(group.jid, generatedVideo.filePath, generatedVideo.mimeType, post.caption);
      finishManualActionJob(groupJid, jobId, 'succeeded', {
        stage: 'Video post sent.',
        result: 'Posted generated video and caption to the group.',
      });
      console.log(`[web-action] Sent manual video post to "${groupLabel}"`);
    } else {
      await sendGroupMessage(group.jid, post.caption);
      finishManualActionJob(groupJid, jobId, 'succeeded', {
        stage: 'Caption-only fallback sent.',
        result: 'Posted the generated caption because no video was returned.',
      });
      console.log(`[web-action] Sent manual video fallback text post to "${groupLabel}"`);
    }
  } finally {
    await cleanupGeneratedVideo(generatedVideo);
  }
}

function startBackgroundManualAction(
  configHolder: ConfigHolder,
  groupJid: string,
  action: ManualGroupAction,
  prompt: string,
  jobId: string,
): void {
  void (async () => {
    try {
      if (action === 'generate-image') {
        await runManualImageAction(configHolder, groupJid, prompt, jobId);
      } else if (action === 'generate-video') {
        await runManualVideoAction(configHolder, groupJid, prompt, jobId);
      } else if (action === 'send-next-event') {
        await runManualNextEventAction(configHolder, groupJid, jobId);
      }
    } catch (err) {
      finishManualActionJob(groupJid, jobId, 'failed', {
        stage: 'Manual post failed.',
        error: describeError(err),
      });
      console.error(`[web-action] Failed ${action} for ${groupJid}:`, err);
    }
  })();
}

export function startWebServer(
  configHolder: ConfigHolder,
  configPath: string,
  port: number,
  adminToken: string,
): void {
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  async function refreshCronSchedules(): Promise<void> {
    await startEventCrons(configHolder);
    await startScheduledPostCrons(configHolder);
  }

  // Admin auth middleware
  function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (req.query['token'] !== adminToken) {
      res.status(403).send(renderError('Invalid or missing admin token.'));
      return;
    }
    next();
  }

  // --- Admin Routes ---

  app.get('/admin', requireAdmin, (_req: Request, res: Response) => {
    res.send(renderAdminDashboard(configHolder.current, adminToken));
  });

  app.get('/admin/global', requireAdmin, (_req: Request, res: Response) => {
    res.send(renderAdminGlobalEdit(configHolder.current, adminToken));
  });

  app.post('/admin/global', requireAdmin, (req: Request, res: Response) => {
    try {
      updateConfigFile(configPath, configHolder, (raw) => {
        if (!raw.global) raw.global = {};
        if (req.body.claudeModel) raw.global.claudeModel = req.body.claudeModel;
        const maxTokens = parseInt(req.body.claudeMaxTokens, 10);
        if (!isNaN(maxTokens) && maxTokens > 0) raw.global.claudeMaxTokens = maxTokens;
        const chatMaxOutputTokens = parseInt(req.body.chatMaxOutputTokens, 10);
        if (!isNaN(chatMaxOutputTokens) && chatMaxOutputTokens > 0) raw.global.chatMaxOutputTokens = chatMaxOutputTokens;
        if (req.body.geminiImageModel) raw.global.geminiImageModel = req.body.geminiImageModel;
        if (req.body.geminiVideoModel) raw.global.geminiVideoModel = req.body.geminiVideoModel;
      });
      res.send(renderSuccess('Global settings saved.', `/admin?token=${adminToken}`));
    } catch (err) {
      res.status(500).send(renderError(`Failed to save: ${err}`));
    }
  });

  app.get('/admin/group/:jid', requireAdmin, (req: Request, res: Response) => {
    const group = configHolder.current.groups.find((g) => g.jid === req.params['jid']);
    if (!group) {
      res.status(404).send(renderError('Group not found.'));
      return;
    }
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.send(renderAdminGroupEdit(
      configHolder.current,
      group,
      adminToken,
      baseUrl,
      getManualActionJobsForGroup(group.jid),
    ));
  });

  app.post('/admin/group/:jid', requireAdmin, async (req: Request, res: Response) => {
    try {
      const jid = req.params['jid'];
      updateConfigFile(configPath, configHolder, (raw) => {
        const groups: any[] = raw.groups ?? [];
        const group = groups.find((g: any) => g.jid === jid);
        if (!group) throw new Error('Group not found in config file.');

        // Chatbot settings
        if (!group.chatbot) group.chatbot = {};
        group.chatbot.enabled = !!req.body.chatbotEnabled;
        group.chatbot.botName = req.body.botName || group.chatbot.botName || 'bot';
        group.chatbot.systemPrompt = req.body.systemPrompt || group.chatbot.systemPrompt;
        const allowedModelIds = parseSelectedModelIds(req.body.allowedModelIds);
        const knownModelIds = new Set(configHolder.current.global.chatModels.map((model) => model.id.toLowerCase()));
        const validAllowedModelIds = allowedModelIds.filter((id) => knownModelIds.has(id.toLowerCase()));
        if (group.chatbot.enabled && validAllowedModelIds.length === 0) {
          throw new Error('At least one allowed chat model must be selected when chatbot is enabled.');
        }
        group.chatbot.allowedModelIds = validAllowedModelIds;
        const defaultModelId = getTrimmedString(req.body.defaultModelId);
        group.chatbot.defaultModelId = validAllowedModelIds.find((id) => id.toLowerCase() === defaultModelId.toLowerCase())
          ?? validAllowedModelIds[0];
        if (group.chatbot.activeModelId && !validAllowedModelIds.some((id) => id.toLowerCase() === String(group.chatbot.activeModelId).toLowerCase())) {
          group.chatbot.activeModelId = group.chatbot.defaultModelId;
        }
        group.chatbot.enableThinking = req.body.enableThinking === '1';
        const thinkingBudget = parseInt(req.body.thinkingBudget, 10);
        if (!isNaN(thinkingBudget) && thinkingBudget > 0) group.chatbot.thinkingBudget = thinkingBudget;
        group.chatbot.enableWebSearch = req.body.enableWebSearch === '1';
        const maxSearches = parseInt(req.body.maxSearches, 10);
        if (!isNaN(maxSearches) && maxSearches > 0) group.chatbot.maxSearches = maxSearches;
        const hotness = parseInt(req.body.hotness, 10);
        if (!isNaN(hotness)) group.chatbot.hotness = Math.max(0, Math.min(100, hotness));
        const rateLimitCount = parseInt(req.body.responseRateLimitCount, 10);
        if (!isNaN(rateLimitCount) && rateLimitCount > 0) group.chatbot.responseRateLimitCount = rateLimitCount;
        const rateLimitWindowSec = parseInt(req.body.responseRateLimitWindowSec, 10);
        if (!isNaN(rateLimitWindowSec) && rateLimitWindowSec > 0) group.chatbot.responseRateLimitWindowSec = rateLimitWindowSec;
        group.chatbot.responseRateLimitWarn = req.body.responseRateLimitWarn === '1';
        group.chatbot.enableImageGeneration = req.body.enableImageGeneration === '1';
        group.chatbot.enableVideoGeneration = req.body.enableVideoGeneration === '1';
        group.chatbot.enableAutoImageReplies = req.body.enableAutoImageReplies === '1';

        // Events settings
        if (req.body.eventsEnabled) {
          if (!group.events) group.events = {};
          group.events.spreadsheetId = req.body.spreadsheetId || group.events.spreadsheetId;
          group.events.sheetName = req.body.sheetName || 'Sheet1';
          group.events.messageTemplate = req.body.messageTemplate || group.events.messageTemplate;
          group.events.cronSchedule = req.body.cronSchedule || group.events.cronSchedule || '0 8 * * *';
          group.events.enableImageAnnouncements = req.body.enableEventImageAnnouncements === '1';
        } else {
          delete group.events;
        }

        group.scheduledPosts = parseScheduledPosts(req.body.scheduledPostsJson, req.body);
      });
      await refreshCronSchedules();
      res.send(renderSuccess('Group settings saved.', `/admin?token=${adminToken}`));
    } catch (err) {
      res.status(500).send(renderError(`Failed to save: ${err}`));
    }
  });

  app.post('/admin/group/:jid/regenerate-token', requireAdmin, (req: Request, res: Response) => {
    try {
      const jid = req.params['jid'] as string;
      updateConfigFile(configPath, configHolder, (raw) => {
        const groups: any[] = raw.groups ?? [];
        const group = groups.find((g: any) => g.jid === jid);
        if (!group) throw new Error('Group not found in config file.');
        group.webToken = randomUUID();
      });
      res.send(renderSuccess('Token regenerated.', `/admin/group/${encodeURIComponent(jid)}?token=${adminToken}`));
    } catch (err) {
      res.status(500).send(renderError(`Failed to regenerate token: ${err}`));
    }
  });

  app.post('/admin/group/:jid/action', requireAdmin, async (req: Request, res: Response) => {
    try {
      const jid = req.params['jid'] as string;
      const group = configHolder.current.groups.find((g) => g.jid === jid);
      if (!group) {
        res.status(404).send(renderError('Group not found.'));
        return;
      }

      const action = parseManualGroupAction(req.body.action);
      const backUrl = `/admin/group/${encodeURIComponent(group.jid)}?token=${adminToken}`;
      if (action === 'send-next-event') {
        const job = createManualActionJob(group.jid, action, 'Send next event message now');
        startBackgroundManualAction(configHolder, group.jid, action, '', job.id);
        res.redirect(`${backUrl}&job=${encodeURIComponent(job.id)}`);
        return;
      }

      if (action === 'send-message') {
        const text = getRequiredText(req.body.text, 'Message text', MANUAL_ACTION_TEXT_MAX_CHARS);
        const job = createManualActionJob(group.jid, action, text);
        await runManualTextAction(configHolder, group.jid, text, job.id);
        res.redirect(`${backUrl}&job=${encodeURIComponent(job.id)}`);
        return;
      }

      const prompt = getRequiredText(req.body.prompt, 'Generation prompt', MANUAL_ACTION_PROMPT_MAX_CHARS);
      const job = createManualActionJob(group.jid, action, prompt);
      startBackgroundManualAction(configHolder, group.jid, action, prompt, job.id);
      res.redirect(`${backUrl}&job=${encodeURIComponent(job.id)}`);
    } catch (err) {
      res.status(500).send(renderError(`Failed to run group action: ${err}`));
    }
  });

  // --- Per-Group Routes ---

  app.get('/group/:webToken', (req: Request, res: Response) => {
    const group = configHolder.current.groups.find((g) => g.webToken === req.params['webToken']);
    if (!group) {
      res.status(404).send(renderError('Invalid group link.'));
      return;
    }
    const saved = req.query['saved'] === '1';
    res.send(renderGroupEdit(
      configHolder.current,
      group,
      saved,
      getManualActionJobsForGroup(group.jid),
    ));
  });

  app.post('/group/:webToken', async (req: Request, res: Response) => {
    const webToken = req.params['webToken'];
    const group = configHolder.current.groups.find((g) => g.webToken === webToken);
    if (!group) {
      res.status(404).send(renderError('Invalid group link.'));
      return;
    }

    try {
      const jid = group.jid;
      updateConfigFile(configPath, configHolder, (raw) => {
        const groups: any[] = raw.groups ?? [];
        const g = groups.find((gr: any) => gr.jid === jid);
        if (!g) throw new Error('Group not found in config file.');

        if (!g.chatbot) g.chatbot = {};
        if (req.body.botName) g.chatbot.botName = req.body.botName;
        if (req.body.systemPrompt !== undefined) g.chatbot.systemPrompt = req.body.systemPrompt;
        g.chatbot.enableThinking = req.body.enableThinking === '1';
        const thinkingBudget = parseInt(req.body.thinkingBudget, 10);
        if (!isNaN(thinkingBudget) && thinkingBudget > 0) g.chatbot.thinkingBudget = thinkingBudget;
        g.chatbot.enableWebSearch = req.body.enableWebSearch === '1';
        const maxSearches = parseInt(req.body.maxSearches, 10);
        if (!isNaN(maxSearches) && maxSearches > 0) g.chatbot.maxSearches = maxSearches;
        const hotness = parseInt(req.body.hotness, 10);
        if (!isNaN(hotness)) g.chatbot.hotness = Math.max(0, Math.min(100, hotness));
        const rateLimitCount = parseInt(req.body.responseRateLimitCount, 10);
        if (!isNaN(rateLimitCount) && rateLimitCount > 0) g.chatbot.responseRateLimitCount = rateLimitCount;
        const rateLimitWindowSec = parseInt(req.body.responseRateLimitWindowSec, 10);
        if (!isNaN(rateLimitWindowSec) && rateLimitWindowSec > 0) g.chatbot.responseRateLimitWindowSec = rateLimitWindowSec;
        g.chatbot.responseRateLimitWarn = req.body.responseRateLimitWarn === '1';
        g.chatbot.enableImageGeneration = req.body.enableImageGeneration === '1';
        g.chatbot.enableVideoGeneration = req.body.enableVideoGeneration === '1';
        g.chatbot.enableAutoImageReplies = req.body.enableAutoImageReplies === '1';
        g.scheduledPosts = parseScheduledPosts(req.body.scheduledPostsJson, req.body);
      });
      await refreshCronSchedules();

      // Re-lookup the webToken (it shouldn't change, but use fresh config)
      const updatedGroup = configHolder.current.groups.find((g) => g.jid === jid);
      const token = updatedGroup?.webToken ?? webToken;
      res.redirect(`/group/${token}?saved=1`);
    } catch (err) {
      res.status(500).send(renderError(`Failed to save: ${err}`));
    }
  });

  app.post('/group/:webToken/action', async (req: Request, res: Response) => {
    const webToken = req.params['webToken'];
    const group = configHolder.current.groups.find((g) => g.webToken === webToken);
    if (!group) {
      res.status(404).send(renderError('Invalid group link.'));
      return;
    }

    try {
      const action = parseManualGroupAction(req.body.action);
      const backUrl = `/group/${webToken}`;
      if (action === 'send-next-event') {
        const job = createManualActionJob(group.jid, action, 'Send next event message now');
        startBackgroundManualAction(configHolder, group.jid, action, '', job.id);
        res.redirect(`${backUrl}?job=${encodeURIComponent(job.id)}`);
        return;
      }

      if (action === 'send-message') {
        const text = getRequiredText(req.body.text, 'Message text', MANUAL_ACTION_TEXT_MAX_CHARS);
        const job = createManualActionJob(group.jid, action, text);
        await runManualTextAction(configHolder, group.jid, text, job.id);
        res.redirect(`${backUrl}?job=${encodeURIComponent(job.id)}`);
        return;
      }

      const prompt = getRequiredText(req.body.prompt, 'Generation prompt', MANUAL_ACTION_PROMPT_MAX_CHARS);
      const job = createManualActionJob(group.jid, action, prompt);
      startBackgroundManualAction(configHolder, group.jid, action, prompt, job.id);
      res.redirect(`${backUrl}?job=${encodeURIComponent(job.id)}`);
    } catch (err) {
      res.status(500).send(renderError(`Failed to run group action: ${err}`));
    }
  });

  app.listen(port, () => {
    console.log(`Web admin running at http://localhost:${port}/admin?token=***`);
  });
}
