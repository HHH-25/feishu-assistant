import { randomUUID } from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { authenticate, authorizeEmployee, authorizeSpace, authorizeSummary, canReadArchive } from './auth.js';
import type { ApiActor } from './auth.js';
import type { AppClients } from './clients/factory.js';
import { config, MAX_FILE_BYTES } from './config.js';
import { seedDemoDailyReports } from './demo/seedDaily.js';
import { logger } from './logger.js';
import { ArchiveService, AppError } from './services/archive.js';
import { EmployeeDailyService } from './services/employeeDaily.js';
import { DailySummaryService } from './services/dailySummary.js';
import { DailySummaryScheduler } from './services/scheduler.js';
import { registerAdminRoutes } from './adminRoutes.js';
import { registerWikiRoutes } from './wikiRoutes.js';
import type { Confidentiality } from './types.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

export interface CreatedApp {
  app: express.Express;
  archiveService: ArchiveService;
  dailyService: DailySummaryService;
  scheduler: DailySummaryScheduler;
}

export function createApp(clients: AppClients): CreatedApp {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const archiveService = new ArchiveService(clients.feishu, clients.state);
  const employeeDaily = new EmployeeDailyService(clients.feishu, clients.state);
  const dailyService = new DailySummaryService(clients.feishu, clients.model, clients.state);
  const scheduler = new DailySummaryScheduler(dailyService);

  const auditDenial = async (actor: ApiActor, action: string, resource: string, requestId: string) => {
    try {
      await clients.feishu.writeAudit({
        id: randomUUID(), request_id: requestId, operator: actor.operator,
        action, resource, result: 'deny', at: new Date().toISOString(),
      });
    } catch {
      logger.warn('权限拒绝审计写入失败', { request_id: requestId, action, resource });
    }
  };

  app.use((req, res, next) => {
    const requestId = (req.header('x-request-id') || randomUUID()).toString();
    (req as Request & { requestId: string }).requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      mode: config.clientMode,
      model_mode: config.clientMode === 'mock' ? 'mock' : config.modelMode,
      time: new Date().toISOString(),
      daily_cron: scheduler.getStatus(),
    });
  });

  app.post('/api/v1/archives', upload.single('file'), async (req, res, next) => {
    try {
      const requestId = (req as Request & { requestId: string }).requestId;
      if (!req.file) throw new AppError('VALIDATION', '缺少 file 字段', 400);

      const department = String(req.body.department ?? '');
      const confidentiality = String(req.body.confidentiality ?? '') as Confidentiality;
      const spaceId = String(req.body.space_id ?? req.body.spaceId ?? '');
      const actor = authenticate(req);
      if (actor.kind === 'employee') {
        await auditDenial(actor, 'archive', spaceId, requestId);
        throw new AppError('FORBIDDEN', '员工请使用员工归档入口', 403);
      }
      const operator = actor.operator;
      try {
        authorizeSpace(actor, spaceId, confidentiality);
      } catch (err) {
        await auditDenial(actor, 'archive', spaceId, requestId);
        throw err;
      }
      const source = req.body.source ? String(req.body.source) : 'api';
      const fileType = req.body.file_type ? String(req.body.file_type) : undefined;
      const owner = req.body.owner ? String(req.body.owner) : undefined;

      const result = await archiveService.archive(
        {
          fileName: req.file.originalname,
          buffer: req.file.buffer,
          department,
          confidentiality,
          spaceId,
          operator,
          source,
          fileType,
          owner,
          financeAuthorized: config.clientMode === 'real' ? actor.finance : undefined,
        },
        requestId,
      );

      res.json({
        ok: true,
        archive_id: result.archive_id,
        file_id: result.file_id,
        feishu_url: result.feishu_url,
        content_hash: result.content_hash,
        version: result.version,
        status: result.status,
        deduplicated: result.deduplicated,
        previous_file_id: result.previous_file_id,
        department: result.department,
        file_type: result.file_type,
        confidentiality: result.confidentiality,
        space_id: result.space_id,
        archive_key: result.archive_key,
        uploader: result.uploader,
        source: result.source,
        owner: result.owner,
        uploaded_at: result.uploaded_at,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/employee/archives', upload.single('file'), async (req, res, next) => {
    try {
      const actor = authenticate(req);
      try { authorizeEmployee(actor); }
      catch (err) { await auditDenial(actor, 'employee_archive', 'employee',
        (req as Request & { requestId: string }).requestId); throw err; }
      if (!req.file) throw new AppError('VALIDATION', '缺少 file 字段', 400);
      const spaceId = actor.default_space_id;
      const confidentiality = actor.default_confidentiality;
      try { authorizeSpace(actor, spaceId, confidentiality); }
      catch (err) { await auditDenial(actor, 'employee_archive', spaceId,
        (req as Request & { requestId: string }).requestId); throw err; }
      const result = await archiveService.archive({
        fileName: req.file.originalname, buffer: req.file.buffer,
        department: actor.department, confidentiality, spaceId,
        operator: actor.operator, owner: actor.employee, source: 'workbuddy',
        financeAuthorized: actor.finance,
      }, (req as Request & { requestId: string }).requestId);
      // 去重可能命中同空间另一位员工的文件；员工不能借此取得对方的归档 ID 或链接。
      if (result.deduplicated && result.uploader !== actor.operator) {
        res.json({ ok: true, status: 'duplicate', deduplicated: true,
          message: '文件已在该空间归档，未重复上传' });
        return;
      }
      res.json({ ok: true, archive_id: result.archive_id, file_id: result.file_id,
        feishu_url: result.feishu_url, status: result.status, version: result.version,
        deduplicated: result.deduplicated, uploader: result.uploader });
    } catch (err) { next(err); }
  });

  app.post('/api/v1/employee/daily-report', async (req, res, next) => {
    try {
      const actor = authenticate(req);
      try { authorizeEmployee(actor); }
      catch (err) { await auditDenial(actor, 'daily_report_submit', 'employee',
        (req as Request & { requestId: string }).requestId); throw err; }
      const forbidden = ['employee', 'department', 'confidentiality', 'date', 'operator', 'space_id'];
      if (forbidden.some((field) => Object.hasOwn(req.body ?? {}, field))) {
        await auditDenial(actor, 'daily_report_submit', 'identity_fields',
          (req as Request & { requestId: string }).requestId);
        throw new AppError('VALIDATION', '员工身份、部门、日期和密级由服务端确定', 400);
      }
      const result = await employeeDaily.submit(actor, req.body,
        (req as Request & { requestId: string }).requestId);
      res.json({ ok: true, record_id: result.report.record_id,
        business_date: result.report.date, submit_status: result.report.submit_status,
        updated: result.updated, employee: result.report.employee });
    } catch (err) { next(err); }
  });

  app.get('/api/v1/employee/daily-report', async (req, res, next) => {
    try {
      const actor = authenticate(req);
      try { authorizeEmployee(actor); }
      catch (err) { await auditDenial(actor, 'daily_report_read', 'employee',
        (req as Request & { requestId: string }).requestId); throw err; }
      const date = req.query.date;
      if (date !== undefined && typeof date !== 'string') {
        throw new AppError('VALIDATION', 'date 格式无效', 400);
      }
      const report = await employeeDaily.get(actor, date);
      res.json({ ok: true, report });
    } catch (err) { next(err); }
  });

  app.get('/api/v1/archives', async (req, res, next) => {
    try {
      const actor = authenticate(req);
      const queryValue = (name: string): string => {
        const value = req.query[name];
        if (value === undefined) return '';
        if (typeof value !== 'string') throw new AppError('VALIDATION', `${name} 参数无效`, 400);
        return value.trim();
      };
      const spaceId = queryValue('space_id');
      const fileName = queryValue('file_name').toLocaleLowerCase();
      const department = queryValue('department');
      const status = queryValue('status');
      const pageText = queryValue('page') || '1';
      const pageSizeText = queryValue('page_size') || '50';
      if (!/^[1-9]\d*$/.test(pageText) || !/^[1-9]\d*$/.test(pageSizeText) ||
          Number(pageSizeText) > 100 || !Number.isSafeInteger(Number(pageText))) {
        throw new AppError('VALIDATION', 'page 必须为正整数，page_size 必须为 1–100', 400);
      }
      if (status && !['pending', 'success', 'failed', 'duplicate'].includes(status)) {
        throw new AppError('VALIDATION', 'status 无效', 400);
      }
      if (spaceId) {
        try { authorizeSpace(actor, spaceId); }
        catch (err) {
          await auditDenial(actor, 'archive_list', spaceId,
            (req as Request & { requestId: string }).requestId);
          throw err;
        }
      }
      const visible = (await archiveService.list())
        .filter((record) => canReadArchive(actor, record))
        .filter((record) => actor.kind !== 'employee' || record.uploader === actor.operator)
        .filter((record) => (!spaceId || record.space_id === spaceId) &&
          (!fileName || record.file_name.toLocaleLowerCase().includes(fileName)) &&
          (!department || record.department === department) &&
          (!status || record.status === status))
        .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at) ||
          b.archive_id.localeCompare(a.archive_id));
      const page = Number(pageText);
      const pageSize = Number(pageSizeText);
      const start = (page - 1) * pageSize;
      res.json({ ok: true, archives: visible.slice(start, start + pageSize),
        total: visible.length, page, page_size: pageSize });
    } catch (err) { next(err); }
  });

  app.get('/api/v1/archives/:archiveId', async (req, res, next) => {
    try {
      const actor = authenticate(req);
      const record = await archiveService.getStatus(req.params.archiveId);
      try {
        authorizeSpace(actor, record.space_id, record.confidentiality);
        if (actor.kind === 'employee' && record.uploader !== actor.operator) {
          throw new AppError('FORBIDDEN', '员工只能查看自己的归档记录', 403);
        }
      } catch (err) {
        await auditDenial(actor, 'archive_read', record.space_id,
          (req as unknown as { requestId: string }).requestId);
        throw err;
      }
      res.json({ ok: true, archive: record,
        upload: clients.state?.getUpload(record.archive_key) ?? null });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/daily-summary/run', async (req, res, next) => {
    try {
      const requestId = (req as Request & { requestId: string }).requestId;
      const businessDate = String(req.body.business_date ?? '');
      const actor = authenticate(req);
      try {
        authorizeSummary(actor);
      } catch (err) {
        await auditDenial(actor, 'daily_summary', businessDate, requestId);
        throw err;
      }
      const operator = actor.operator || 'admin';
      const trigger = 'manual';
      const result = await dailyService.run({
        businessDate,
        operator,
        trigger,
        requestId,
      });
      res.json({
        ok: true,
        run_id: result.run.run_id,
        business_date: result.summary.business_date,
        missing: result.missing,
        summary_id: result.summary.summary_id,
        revision: result.summary.revision,
        message_sent: result.message_sent,
        idempotent_skip_send: result.idempotent_skip_send,
        trigger: result.run.trigger,
        content_preview: result.summary.content.slice(0, 200),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/daily-summary/schedule', (_req, res) => {
    res.json({ ok: true, schedule: scheduler.getStatus() });
  });

  app.get('/api/v1/daily-summary/:businessDate/status', async (req, res, next) => {
    try {
      const actor = authenticate(req);
      try { authorizeSummary(actor); }
      catch (err) {
        await auditDenial(actor, 'daily_summary_status', req.params.businessDate,
          (req as unknown as { requestId: string }).requestId);
        throw err;
      }
      const businessDate = req.params.businessDate;
      const job = await clients.feishu.getJobRunByKey(`daily_summary:${businessDate}`);
      res.json({ ok: true, business_date: businessDate, job,
        send: clients.state?.getSend(businessDate) ?? null });
    } catch (err) { next(err); }
  });

  app.post('/api/v1/recovery/message', async (req, res, next) => {
    try {
      const actor = authenticate(req);
      try { authorizeSummary(actor); }
      catch (err) {
        await auditDenial(actor, 'reconcile_message', String(req.body.business_date ?? ''),
          (req as unknown as { requestId: string }).requestId);
        throw err;
      }
      if (!clients.state) throw new AppError('VALIDATION', '仅真实模式支持发送核对', 400);
      const date = String(req.body.business_date ?? '');
      const messageId = String(req.body.delivered_message_id ?? '');
      const confirmedNotDelivered = req.body.confirmed_not_delivered === true;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Boolean(messageId) === confirmedNotDelivered) {
        throw new AppError('VALIDATION', '提供 delivered_message_id 或 confirmed_not_delivered=true', 400);
      }
      const current = clients.state.getSend(date);
      if (!current || !['sending', 'uncertain'].includes(current.state)) {
        throw new AppError('CONFLICT', '仅待核对的发送可处理', 409);
      }
      clients.state.reconcileSend(date, messageId || undefined);
      await clients.feishu.writeAudit({ id: randomUUID(),
        request_id: (req as unknown as { requestId: string }).requestId,
        operator: actor.operator, action: 'reconcile_message', resource: date,
        result: 'success', detail: messageId ? '确认已送达' : '确认未送达', at: new Date().toISOString() });
      res.json({ ok: true, business_date: date, send: clients.state.getSend(date) });
    } catch (err) { next(err); }
  });

  app.post('/api/v1/recovery/upload', async (req, res, next) => {
    try {
      const actor = authenticate(req);
      try { authorizeSummary(actor); }
      catch (err) {
        await auditDenial(actor, 'reconcile_upload', String(req.body.archive_key ?? ''),
          (req as unknown as { requestId: string }).requestId);
        throw err;
      }
      if (!clients.state) throw new AppError('VALIDATION', '仅真实模式支持上传核对', 400);
      const key = String(req.body.archive_key ?? '');
      const fileId = String(req.body.file_id ?? '');
      const url = String(req.body.feishu_url ?? '');
      const confirmedNoUpload = req.body.confirmed_no_upload === true;
      if (!key.startsWith('hash:') ||
          !((fileId && url && !confirmedNoUpload) || (!fileId && !url && confirmedNoUpload))) {
        throw new AppError('VALIDATION', '提供 file_id 与 feishu_url，或 confirmed_no_upload=true', 400);
      }
      const current = clients.state.getUpload(key);
      const match = /^hash:([0-9a-f]{64})\|space:([^|]+)$/.exec(key);
      const spaceId = match?.[2];
      if (!spaceId) throw new AppError('VALIDATION', 'archive_key 无效', 400);
      const ledger = await clients.feishu.findLedgerByHash(match[1], spaceId);
      try { authorizeSpace(actor, spaceId, ledger?.confidentiality); }
      catch (err) {
        await auditDenial(actor, 'reconcile_upload', spaceId,
          (req as unknown as { requestId: string }).requestId);
        throw err;
      }
      if (!current || !['uploading', 'uncertain'].includes(current.state)) {
        throw new AppError('CONFLICT', '仅待核对的上传可处理', 409);
      }
      clients.state.reconcileUpload(key, fileId || undefined, url || undefined);
      await clients.feishu.writeAudit({ id: randomUUID(),
        request_id: (req as unknown as { requestId: string }).requestId,
        operator: actor.operator, action: 'reconcile_upload', resource: key,
        result: 'success', detail: fileId ? '确认已上传' : '确认未上传', at: new Date().toISOString() });
      res.json({ ok: true, archive_key: key, upload: clients.state.getUpload(key) });
    } catch (err) { next(err); }
  });

  /** 仅 mock：注入演示日报（A/B 已交、C 缺交），便于 REST 演示日报闭环 */
  app.post('/api/v1/mock/seed-daily', (req, res, next) => {
    try {
      if (config.clientMode !== 'mock' || !clients.mockFeishu) {
        throw new AppError('VALIDATION', '仅 CLIENT_MODE=mock 可用该演示接口', 403);
      }
      const businessDate = String(req.body.business_date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
        throw new AppError('VALIDATION', 'business_date 格式应为 YYYY-MM-DD', 400);
      }
      const seeded = seedDemoDailyReports(clients.mockFeishu, businessDate);
      logger.info('mock 日报种子已注入', {
        business_date: businessDate,
        expected: seeded.expected.length,
        reports: seeded.reports.length,
      });
      res.json({
        ok: true,
        business_date: businessDate,
        expected: seeded.expected,
        submitted: seeded.reports.map((r) => r.employee),
        note: '员工C 故意缺交，用于演示缺交识别',
      });
    } catch (err) {
      next(err);
    }
  });

  if (config.adminWebEnabled) registerAdminRoutes(app, clients, archiveService, dailyService);
  registerWikiRoutes(app, clients);

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req as Request & { requestId?: string }).requestId ?? 'unknown';
    if (err instanceof AppError) {
      logger.warn('业务错误', {
        request_id: requestId,
        code: err.code,
        message: err.message,
        status: err.status,
      });
      res.status(err.status).json({
        ok: false,
        error: { code: err.code, message: err.message, request_id: requestId },
      });
      return;
    }
    if (err instanceof multer.MulterError) {
      res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION', message: err.message, request_id: requestId },
      });
      return;
    }
    logger.error('未处理错误', { request_id: requestId, error: 'UPSTREAM' });
    res.status(500).json({
      ok: false,
      error: { code: 'UPSTREAM', message: '上游服务调用失败，请按 request_id 查询服务端日志', request_id: requestId },
    });
  });

  return { app, archiveService, dailyService, scheduler };
}
