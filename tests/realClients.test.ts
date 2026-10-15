import { describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { RealFeishuClient } from '../src/clients/feishuReal.js';
import { RealModelClient } from '../src/clients/model.js';
import type { ArchiveRecord } from '../src/types.js';

function ok(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ code: 0, data }), { status: 200,
    headers: { 'content-type': 'application/json' } });
}

describe('真实客户端 HTTP 契约（本地模拟响应）', () => {
  it('虚构日报种子按 test_case_id 重复写入不增加记录', async () => {
    const tables = new Map<string, Array<{ record_id: string; fields: Record<string, unknown> }>>();
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }));
      }
      const table = /\/tables\/([^/]+)\/records/.exec(path)?.[1];
      if (!table) throw new Error(`unexpected URL ${path}`);
      const rows = tables.get(table) ?? [];
      tables.set(table, rows);
      if (init?.method === 'GET') return ok({ items: rows, has_more: false });
      const fields = (JSON.parse(String(init?.body)) as { fields: Record<string, unknown> }).fields;
      if (init?.method === 'POST') {
        expect(new URL(path).searchParams.get('client_token')).toMatch(/^[0-9a-f-]{36}$/);
        const row = { record_id: `${table}-${rows.length + 1}`, fields };
        rows.push(row);
        return ok({ record: row });
      }
      const row = rows.find((item) => path.endsWith(item.record_id));
      if (!row) throw new Error('record missing');
      row.fields = fields;
      return ok({ record: row });
    });
    const client = new RealFeishuClient({ ...config.feishu, baseUrl: 'https://fake.local',
      appId: 'app', appSecret: 'secret', bitableAppToken: 'base', expectedTableId: 'expected',
      dailyTableId: 'daily', folderMapJson: '{}' }, fetcher as typeof fetch);
    const id = 'seed:2026-10-15:report_A';
    const first = await client.upsertTestRecord('daily', id, { date: '2026-10-15', employee: '员工A' });
    const second = await client.upsertTestRecord('daily', id, { date: '2026-10-15', employee: '员工A' });
    expect(first).toBe(second);
    expect(tables.get('daily')).toHaveLength(1);
  });

  it('缓存 token，上传指定目录，并在多维表完成台账 upsert', async () => {
    const rows: Array<{ record_id: string; fields: Record<string, unknown> }> = [];
    let tokenCalls = 0;
    let uploadFolder = '';
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/auth/v3/tenant_access_token/internal')) {
        tokenCalls++;
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'test-token', expire: 7200 }));
      }
      if (path.endsWith('/drive/v1/files/upload_all')) {
        uploadFolder = String((init?.body as FormData).get('parent_node'));
        return ok({ file_token: 'file-123' });
      }
      if (path.includes('/records')) {
        if (init?.method === 'GET') return ok({ items: rows, has_more: false });
        const body = JSON.parse(String(init?.body)) as { fields: Record<string, unknown> };
        if (init?.method === 'POST') rows.push({ record_id: 'rec-ledger', fields: body.fields });
        if (init?.method === 'PUT') rows[0].fields = body.fields;
        return ok({ record: rows[0] });
      }
      if (path.includes('/im/v1/messages')) return ok({ message_id: 'msg-123' });
      throw new Error(`unexpected URL ${path}`);
    });
    const client = new RealFeishuClient({ ...config.feishu, baseUrl: 'https://fake.local',
      appId: 'app', appSecret: 'secret', bitableAppToken: 'base', ledgerTableId: 'ledger',
      folderMapJson: '{"space_sales":"folder-sales"}',
      fileUrlTemplate: 'https://tenant.feishu.cn/file/{file_id}' }, fetcher as typeof fetch);

    const uploaded = await client.uploadFile({ fileName: 'demo.txt', buffer: Buffer.from('abc'),
      spaceId: 'space_sales' });
    expect(uploadFolder).toBe('folder-sales');
    expect(uploaded).toEqual({ file_id: 'file-123', feishu_url: 'https://tenant.feishu.cn/file/file-123' });
    const record: ArchiveRecord = { archive_id: 'archive-1', file_name: 'demo.txt', file_id: uploaded.file_id,
      feishu_url: uploaded.feishu_url, content_hash: 'hash-1', department: '销售', file_type: 'txt',
      confidentiality: 'dept', uploader: 'user:alice', source: 'api', uploaded_at: 'now',
      status: 'pending', version: 1, space_id: 'space_sales', archive_key: 'hash:hash-1|space:space_sales',
      updated_at: 'now' };
    await client.writeLedger(record);
    await client.writeLedger({ ...record, status: 'success' });
    expect((await client.findLedgerByHash('hash-1', 'space_sales'))?.status).toBe('success');
    expect(await client.sendMessage({ chatId: 'chat-1', text: 'hello' })).toEqual({ message_id: 'msg-123' });
    expect(tokenCalls).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it('模型请求不持久化输入，输出追加缺交与来源记录', async () => {
    let body: Record<string, unknown> = {};
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [
        { type: 'output_text', text: '今日推进交付。' }] }] }), { status: 200 });
    });
    const client = new RealModelClient({ ...config.model, apiKey: 'test-key', baseUrl: 'https://model.local/v1',
      modelName: 'test-model' }, fetcher as typeof fetch);
    const output = await client.summarizeDaily({ businessDate: '2026-10-14', missingEmployees: ['员工C'],
      reports: [{ record_id: 'rec-A', date: '2026-10-14', employee: '员工A', department: '交付',
        submitted_at: '2026-10-14T18:00:00+08:00', done_today: '推进交付', metrics: '', unfinished: '',
        problems: '', tomorrow_plan: '', need_help: '', need_boss_decision: '', submit_status: 'valid' }] });
    expect(body.store).toBe(false);
    expect(output.content).toContain('员工C');
    expect(output.content).toContain('rec-A');
  });
});
