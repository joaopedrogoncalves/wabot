import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'crypto';
import type { ConfigHolder } from '../config.js';
import { updateConfigFile } from '../config.js';
import {
  renderAdminDashboard,
  renderAdminGlobalEdit,
  renderAdminGroupEdit,
  renderGroupEdit,
  renderSuccess,
  renderError,
} from './templates.js';

export function startWebServer(
  configHolder: ConfigHolder,
  configPath: string,
  port: number,
  adminToken: string,
): void {
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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

  app.post('/admin/group/:jid', requireAdmin, (req: Request, res: Response) => {
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

        // Events settings
        if (req.body.birthdayEnabled) {
          if (!group.events) group.events = {};
          group.events.spreadsheetId = req.body.spreadsheetId || group.events.spreadsheetId;
          group.events.sheetName = req.body.sheetName || 'Sheet1';
          group.events.messageTemplate = req.body.messageTemplate || group.events.messageTemplate;
          group.events.cronSchedule = req.body.cronSchedule || group.events.cronSchedule || '0 8 * * *';
          delete group.birthday;
        } else {
          delete group.events;
          delete group.birthday;
        }
      });
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

  app.post('/group/:webToken', (req: Request, res: Response) => {
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
      });

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
