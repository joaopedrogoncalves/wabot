import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'crypto';
import type { ConfigHolder } from '../config.js';
import { updateConfigFile } from '../config.js';
import { startEventCrons, startScheduledPostCrons } from '../cron.js';
import {
  renderAdminDashboard,
  renderAdminGlobalEdit,
  renderAdminGroupEdit,
  renderGroupEdit,
  renderSuccess,
  renderError,
} from './templates.js';

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
        if (req.body.geminiImageModel) raw.global.geminiImageModel = req.body.geminiImageModel;
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
    res.send(renderAdminGroupEdit(group, adminToken, baseUrl));
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
        group.chatbot.enableAutoImageReplies = req.body.enableAutoImageReplies === '1';

        // Events settings
        if (req.body.eventsEnabled) {
          if (!group.events) group.events = {};
          group.events.spreadsheetId = req.body.spreadsheetId || group.events.spreadsheetId;
          group.events.sheetName = req.body.sheetName || 'Sheet1';
          group.events.messageTemplate = req.body.messageTemplate || group.events.messageTemplate;
          group.events.cronSchedule = req.body.cronSchedule || group.events.cronSchedule || '0 8 * * *';
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

  // --- Per-Group Routes ---

  app.get('/group/:webToken', (req: Request, res: Response) => {
    const group = configHolder.current.groups.find((g) => g.webToken === req.params['webToken']);
    if (!group) {
      res.status(404).send(renderError('Invalid group link.'));
      return;
    }
    const saved = req.query['saved'] === '1';
    res.send(renderGroupEdit(group, saved));
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

  app.listen(port, () => {
    console.log(`Web admin running at http://localhost:${port}/admin?token=${adminToken}`);
  });
}
