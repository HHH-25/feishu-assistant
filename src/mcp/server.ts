import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { authenticateCredential, authorizeSpace, authorizeSummary } from '../auth.js';
import type { ApiActor } from '../auth.js';
import type { AppClients } from '../clients/factory.js';
import { createClients } from '../clients/factory.js';
import { config, MAX_FILE_BYTES } from '../config.js';
import { ArchiveService, AppError } from '../services/archive.js';
import { DailySummaryService } from '../services/dailySummary.js';

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function failure(err: unknown) {
  const message = err instanceof AppError ? err.message : '服务调用失败，请查看受控日志';
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

export function createMcpServer(clients: AppClients, actor: ApiActor): McpServer {
  const archive = new ArchiveService(clients.feishu, clients.state);
  const daily = new DailySummaryService(clients.feishu, clients.model, clients.state);
  const server = new McpServer({ name: 'feishu-enterprise-datacenter', version: '0.2.0' });
  const auditDenial = async (action: string, resource: string) => {
    try {
      await clients.feishu.writeAudit({ id: randomUUID(), request_id: randomUUID(),
        operator: actor.operator, action, resource, result: 'deny', at: new Date().toISOString() });
    } catch { /* 审计上游故障不改变原权限拒绝 */ }
  };

  server.registerTool('archive_file', {
    description: '上传文件到有权限的飞书空间并写入台账',
    inputSchema: z.object({
      file_name: z.string().min(1), content_base64: z.string().min(1),
      department: z.string().min(1), confidentiality: z.enum(['public', 'dept', 'mgmt', 'finance']),
      space_id: z.string().min(1), source: z.string().optional(),
    }),
  }, async (args) => {
    try {
      try { authorizeSpace(actor, args.space_id, args.confidentiality); }
      catch (err) { await auditDenial('archive', args.space_id); throw err; }
      const content = args.content_base64;
      if (content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
        throw new AppError('VALIDATION', 'content_base64 无效或超限', 400);
      }
      const record = await archive.archive({ fileName: args.file_name, buffer: Buffer.from(content, 'base64'),
        department: args.department, confidentiality: args.confidentiality, spaceId: args.space_id,
        source: args.source ?? 'mcp', operator: actor.operator,
        financeAuthorized: config.clientMode === 'real' ? actor.finance : undefined }, randomUUID());
      return result(record);
    } catch (err) { return failure(err); }
  });

  server.registerTool('get_archive_status', {
    description: '查询有权限的归档状态',
    inputSchema: z.object({ archive_id: z.string().uuid() }),
  }, async ({ archive_id }) => {
    try {
      const record = await archive.getStatus(archive_id);
      try { authorizeSpace(actor, record.space_id, record.confidentiality); }
      catch (err) { await auditDenial('archive_read', record.space_id); throw err; }
      return result(record);
    } catch (err) { return failure(err); }
  });

  server.registerTool('trigger_daily_summary', {
    description: '有权限的管理者手动运行某业务日的日报汇总',
    inputSchema: z.object({ business_date: z.iso.date() }),
  }, async ({ business_date }) => {
    try {
      try { authorizeSummary(actor); }
      catch (err) { await auditDenial('daily_summary', business_date); throw err; }
      const output = await daily.run({ businessDate: business_date, operator: actor.operator,
        trigger: 'manual', requestId: randomUUID() });
      return result({ run_id: output.run.run_id, summary_id: output.summary.summary_id,
        missing: output.missing, revision: output.summary.revision,
        message_sent: output.message_sent, idempotent_skip_send: output.idempotent_skip_send });
    } catch (err) { return failure(err); }
  });
  return server;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/src/mcp/server.ts')) {
  process.env.MCP_STDIO = 'true';
  const actor = config.clientMode === 'real'
    ? authenticateCredential(process.env.MCP_API_KEY ?? '')
    : { operator: process.env.MCP_MOCK_OPERATOR || 'user:demo', spaces: ['*'],
      can_run_summary: true, finance: true };
  const clients = createClients();
  void serveStdio(() => createMcpServer(clients, actor));
}
