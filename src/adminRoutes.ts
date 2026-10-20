import { randomUUID, timingSafeEqual } from 'node:crypto';
import type express from 'express';
import multer from 'multer';
import { authorizeSpace, canReadArchive } from './auth.js';
import { AdminWebAuth } from './adminAuth.js';
import { adminHtml, adminScript } from './adminPage.js';
import type { AppClients } from './clients/factory.js';
import { config, MAX_FILE_BYTES } from './config.js';
import { logger } from './logger.js';
import { ArchiveService, AppError } from './services/archive.js';
import type { DailySummaryService } from './services/dailySummary.js';
import type { Confidentiality } from './types.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

function sameOrigin(req: express.Request): void {
  const origin = req.header('origin');
  if (!origin) throw new AppError('FORBIDDEN', '缺少来源校验', 403);
  let parsed: URL;
  try { parsed = new URL(origin); }
  catch { throw new AppError('FORBIDDEN', '来源校验失败', 403); }
  if (parsed.host !== req.header('host') ||
      (config.clientMode === 'real' && parsed.protocol !== 'https:')) {
    throw new AppError('FORBIDDEN', '来源校验失败', 403);
  }
}

function csrfOk(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerAdminRoutes(app: express.Express, clients: AppClients,
  archiveService: ArchiveService, dailyService: DailySummaryService): void {
  if (config.clientMode !== 'real') throw new Error('管理员网页只在真实飞书模式启用');
  const auth = new AdminWebAuth();

  app.use('/admin', (_req, res, next) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    next();
  });

  app.get('/admin', (_req, res) => {
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' https://lf1-cdn-tos.bytegoofy.com; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; object-src 'none'");
    res.type('html').send(adminHtml);
  });
  app.get('/admin/app.js', (_req, res) => {
    res.type('application/javascript').send(adminScript(config.feishu.appId));
  });

  app.post('/admin/auth', async (req, res, next) => {
    try {
      sameOrigin(req);
      const actor = await auth.exchangeCode(String(req.body?.code ?? ''));
      const session = auth.createSession(actor);
      res.cookie('mvp_admin', session.cookie, { httpOnly: true, secure: true,
        sameSite: 'strict', path: '/admin', maxAge: 8 * 60 * 60 * 1000 });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  const requireSession = (req: express.Request) => auth.session(req);
  const requireWrite = (req: express.Request) => {
    sameOrigin(req);
    const session = requireSession(req);
    if (!csrfOk(session.csrf, req.header('x-csrf-token') ?? '')) {
      throw new AppError('FORBIDDEN', '页面验证失效，请刷新后重试', 403);
    }
    return session.actor;
  };
  const auditDenial = async (operator: string, action: string, resource: string) => {
    try {
      await clients.feishu.writeAudit({ id: randomUUID(), request_id: randomUUID(),
        operator, action, resource, result: 'deny', at: new Date().toISOString() });
    } catch { logger.warn('管理员网页权限拒绝审计写入失败', { action, resource }); }
  };

  app.get('/admin/api/me', (req, res, next) => {
    try {
      const { actor, csrf } = requireSession(req);
      res.json({ ok: true, operator: actor.operator, spaces: actor.spaces, csrf });
    } catch (err) { next(err); }
  });

  app.get('/admin/api/archives', async (req, res, next) => {
    try {
      const { actor } = requireSession(req);
      const value = (name: string) => typeof req.query[name] === 'string' ? String(req.query[name]).trim() : '';
      const fileName = value('file_name').toLowerCase();
      const department = value('department');
      const status = value('status');
      const visible = (await archiveService.list())
        .filter((record) => canReadArchive(actor, record))
        .filter((record) => (!fileName || record.file_name.toLowerCase().includes(fileName)) &&
          (!department || record.department === department) && (!status || record.status === status))
        .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at) || b.archive_id.localeCompare(a.archive_id));
      res.json({ ok: true, archives: visible.slice(0, 100), total: visible.length });
    } catch (err) { next(err); }
  });

  app.post('/admin/api/archives', (req, _res, next) => {
    try { requireWrite(req); next(); }
    catch (err) { next(err); }
  }, upload.single('file'), async (req, res, next) => {
    try {
      const actor = requireWrite(req);
      if (!req.file) throw new AppError('VALIDATION', '请选择文件', 400);
      const spaceId = String(req.body.space_id ?? '');
      const confidentiality = String(req.body.confidentiality ?? '') as Confidentiality;
      try { authorizeSpace(actor, spaceId, confidentiality); }
      catch (err) { await auditDenial(actor.operator, 'archive_web', spaceId); throw err; }
      const record = await archiveService.archive({ fileName: req.file.originalname,
        buffer: req.file.buffer, department: String(req.body.department ?? ''),
        confidentiality, spaceId, operator: actor.operator, source: 'feishu_web',
        financeAuthorized: actor.finance }, randomUUID());
      res.json({ ok: true, archive_id: record.archive_id, file_id: record.file_id,
        feishu_url: record.feishu_url, status: record.status, deduplicated: record.deduplicated });
    } catch (err) { next(err); }
  });

  app.post('/admin/api/daily-summary', async (req, res, next) => {
    try {
      const actor = requireWrite(req);
      const businessDate = String(req.body?.business_date ?? '');
      const result = await dailyService.run({ businessDate, operator: actor.operator,
        trigger: 'manual', requestId: randomUUID() });
      res.json({ ok: true, business_date: businessDate, missing: result.missing,
        message_sent: result.message_sent, idempotent_skip_send: result.idempotent_skip_send,
        summary_id: result.summary.summary_id });
    } catch (err) { next(err); }
  });

  app.get('/admin/api/daily-summary/:businessDate', async (req, res, next) => {
    try {
      requireSession(req);
      const date = req.params.businessDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('VALIDATION', '日期格式无效', 400);
      const [job, summary] = await Promise.all([
        clients.feishu.getJobRunByKey(`daily_summary:${date}`),
        clients.feishu.getSummaryByDate(date),
      ]);
      res.json({ ok: true, business_date: date, job, summary,
        send: clients.state?.getSend(date) ?? null });
    } catch (err) { next(err); }
  });
}
