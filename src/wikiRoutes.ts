import type { Express, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod/v4';
import { authenticateCredential, authorizeEmployee } from './auth.js';
import type { AppClients } from './clients/factory.js';
import { config, MAX_FILE_BYTES } from './config.js';
import { AppError } from './services/archive.js';
import { WikiService, wikiDraftSchema, wikiTargetsSchema } from './services/wiki.js';

export function registerWikiRoutes(app: Express, clients: AppClients) {
  if (!config.wikiEnabled) {
    app.use('/api/v1/employee/wiki', (_req, _res, next) =>
      next(new AppError('WIKI_DISABLED', '知识库尚未启用，请管理员完成授权与配置', 503)));
    return;
  }
  if (!clients.wiki || !clients.state) throw new Error('知识库启用需要持久化状态和 Wiki 客户端');
  const service = new WikiService(clients.feishu, clients.wiki, clients.state,
    wikiTargetsSchema.parse(JSON.parse(config.wikiTargetsJson)));
  // Even mock deployments require explicit employee credentials for public publication.
  app.use('/api/v1/employee/wiki', (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = /^Bearer (\S+)$/i.exec(req.header('authorization') ?? '')?.[1] ?? '';
      const actor = authenticateCredential(key); authorizeEmployee(actor);
      res.locals.wikiActor = actor; next();
    } catch (err) { next(err); }
  });
  const wrap = (handler: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try { res.json({ ok: true, ...await handler(req, res) as object }); }
      catch (err) { next(err instanceof z.ZodError ? new AppError('VALIDATION', '知识库参数无效或含未允许字段', 400) : err); }
    };
  const requestId = (req: Request) => String(req.header('x-request-id') || 'wiki');
  app.post('/api/v1/wiki/operations/:id/authorize-create-retry', wrap(async (req) => {
    const key = /^Bearer (\S+)$/i.exec(req.header('authorization') ?? '')?.[1] ?? '';
    const actor = authenticateCredential(key);
    z.object({ verified_absent: z.literal(true) }).strict().parse(req.body);
    return { operation: await service.authorizeCreateRetry(actor,
      z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.id), requestId(req)) };
  }));
  app.post('/api/v1/wiki/operations/:id/reconcile', wrap(async (req) => {
    const key = /^Bearer (\S+)$/i.exec(req.header('authorization') ?? '')?.[1] ?? '';
    const actor = authenticateCredential(key);
    const body = z.object({ node_token: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200),
      verified_complete: z.literal(true) }).strict().parse(req.body);
    return { operation: await service.reconcile(actor,
      z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.id), body.node_token, requestId(req)) };
  }));
  app.get('/api/v1/employee/wiki/targets', wrap(async (_req, res) => ({ targets: service.available(res.locals.wikiActor) })));
  app.post('/api/v1/employee/wiki/documents', wrap(async (req, res) => ({ operation:
    await service.publish(res.locals.wikiActor, wikiDraftSchema.parse(req.body), requestId(req)) })));
  app.post('/api/v1/employee/wiki/files', multer({ storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 2 } }).single('file'), wrap(async (req, res) => {
    const body = z.object({ target: z.string().min(1), public_test_content: z.literal('true') }).strict().parse(req.body);
    if (!req.file) throw new AppError('VALIDATION', '缺少文件', 400);
    // Busboy's default header decoding is latin1 for browser FormData filenames.
    const title = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    return { operation: await service.publish(res.locals.wikiActor, {
      target: body.target, title, buffer: req.file.buffer, public_test_content: true,
    }, requestId(req)) };
  }));
  app.get('/api/v1/employee/wiki/operations/:id', wrap(async (req, res) => ({ operation:
    await service.status(res.locals.wikiActor, z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.id), requestId(req)) })));
  app.get('/api/v1/employee/wiki/nodes', wrap(async (req, res) => {
    const q = z.object({ target: z.string().min(1), query: z.string().max(200).default(''),
      cursor: z.string().max(2048).optional() }).strict().parse(req.query);
    return service.list(res.locals.wikiActor, q.target, q.query, q.cursor, requestId(req));
  }));
  app.get('/api/v1/employee/wiki/nodes/:token', wrap(async (req, res) => {
    const q = z.object({ target: z.string().min(1) }).strict().parse(req.query);
    return service.read(res.locals.wikiActor, q.target,
      z.string().regex(/^[A-Za-z0-9_-]+$/).max(200).parse(req.params.token), requestId(req));
  }));
}
