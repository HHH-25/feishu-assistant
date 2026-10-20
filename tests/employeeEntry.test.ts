import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ApiActor } from '../src/auth.js';
import { MockFeishuClient } from '../src/clients/feishu.js';
import { EmployeeDailyService } from '../src/services/employeeDaily.js';
import { createEmployeeMcpServer, loadEmployeeMcpSettings } from '../src/workbuddy/server.js';

const financeKey = 'finance-employee-key-at-least-24-characters';
const normalKey = 'ordinary-employee-key-at-least-24-characters';
const finance: ApiActor = {
  kind: 'employee', operator: 'finance:hyh', employee: 'hyh', department: '财务',
  spaces: ['space_finance_test'], default_space_id: 'space_finance_test',
  default_confidentiality: 'finance', finance: true, can_run_summary: false,
};

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('员工日报与受控入口', () => {
  it('同一员工同日更新同一记录，首次过 20:00 才标为迟交', async () => {
    const feishu = new MockFeishuClient();
    let now = new Date('2026-10-20T11:30:00Z'); // 上海 19:30
    const service = new EmployeeDailyService(feishu, undefined, () => now);
    const first = await service.submit(finance, { done_today: '核对虚构报表' }, 'req-1');
    now = new Date('2026-10-20T12:10:00Z'); // 上海 20:10
    const second = await service.submit(finance, { done_today: '完成虚构报表' }, 'req-2');
    expect(second.updated).toBe(true);
    expect(second.report.record_id).toBe(first.report.record_id);
    expect(second.report.submit_status).toBe('valid');
    expect(second.report.employee).toBe('hyh');
    expect(second.report.confidentiality).toBe('finance');
    expect((await feishu.listDailyReports('2026-10-20'))).toHaveLength(1);
    expect((await feishu.listAudits()).map((audit) => audit.action))
      .toEqual(['daily_report_submit', 'daily_report_update']);

    now = new Date('2026-10-21T12:01:00Z');
    const late = await service.submit(finance, { done_today: '次日虚构日报' }, 'req-3');
    expect(late.report.submit_status).toBe('late');
    expect(late.report.record_id).not.toBe(first.report.record_id);
  });

  it('员工专用 REST 凭证不能冒填身份、使用管理入口或读取别人的归档', async () => {
    vi.stubEnv('CLIENT_MODE', 'real');
    vi.stubEnv('API_ACTORS_JSON', JSON.stringify([
      { key: financeKey, ...finance },
      { key: normalKey, kind: 'employee', operator: 'user:6666', employee: '6666ZK',
        department: '销售', spaces: ['space_public_test'], default_space_id: 'space_public_test',
        default_confidentiality: 'public', finance: false, can_run_summary: false },
    ]));
    const { createApp } = await import('../src/app.js');
    const feishu = new MockFeishuClient();
    const { MockModelClient } = await import('../src/clients/model.js');
    const { app } = createApp({ feishu, model: new MockModelClient() });
    const financeAuth = `Bearer ${financeKey}`;
    const normalAuth = `Bearer ${normalKey}`;

    expect((await request(app).post('/api/v1/employee/daily-report')
      .send({ done_today: '虚构' })).status).toBe(401);
    const forged = await request(app).post('/api/v1/employee/daily-report')
      .set('Authorization', financeAuth)
      .send({ done_today: '虚构', employee: '员工A', confidentiality: 'public' });
    expect(forged.status).toBe(400);
    const submitted = await request(app).post('/api/v1/employee/daily-report')
      .set('Authorization', financeAuth).send({ done_today: '虚构财务日报' });
    expect(submitted.status).toBe(200);
    const saved = await request(app).get('/api/v1/employee/daily-report')
      .set('Authorization', financeAuth);
    expect(saved.body.report.employee).toBe('hyh');
    expect(saved.body.report.confidentiality).toBe('finance');
    expect((await request(app).post('/api/v1/daily-summary/run')
      .set('Authorization', financeAuth).send({ business_date: '2026-10-20' })).status).toBe(403);
    expect((await request(app).post('/api/v1/archives')
      .set('Authorization', financeAuth).field('department', '销售')
      .field('confidentiality', 'public').field('space_id', 'space_public_test')
      .attach('file', Buffer.from('forged'), 'forged.txt')).status).toBe(403);

    const archived = await request(app).post('/api/v1/employee/archives')
      .set('Authorization', financeAuth)
      .field('department', '销售').field('space_id', 'space_public_test')
      .attach('file', Buffer.from('fictional finance file'), 'finance.txt');
    expect(archived.status).toBe(200);
    expect(archived.body.uploader).toBe('finance:hyh');
    const record = await feishu.getLedger(archived.body.archive_id);
    expect(record?.department).toBe('财务');
    expect(record?.space_id).toBe('space_finance_test');
    expect(record?.confidentiality).toBe('finance');
    expect((await request(app).get(`/api/v1/archives/${archived.body.archive_id}`)
      .set('Authorization', normalAuth)).status).toBe(403);
    expect((await feishu.listAudits()).some((audit) =>
      audit.operator === 'user:6666' && audit.action === 'archive_read' && audit.result === 'deny')).toBe(true);
  });
});

describe('WorkBuddy 本地 MCP', () => {
  it('从独立文件读取员工凭证，不要求把凭证写入 MCP 配置', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvp-employee-key-'));
    const credentialFile = path.join(root, 'credential.txt');
    writeFileSync(credentialFile, `${financeKey}\n`);
    const settings = await loadEmployeeMcpSettings({
      MVP_EMPLOYEE_TOKEN_FILE: credentialFile,
      MVP_BASE_URL: 'http://127.0.0.1:3001',
      MVP_UPLOAD_ROOT: root,
    });
    expect(settings.token).toBe(financeKey);
    await expect(loadEmployeeMcpSettings({ MVP_EMPLOYEE_TOKEN_FILE: 'credential.txt' }))
      .rejects.toThrow('绝对路径');
  });

  it('只读取授权目录内文件，以 multipart 传给员工接口', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mvp-workbuddy-'));
    const file = path.join(root, 'fictional.xlsx');
    writeFileSync(file, Buffer.from('fictional spreadsheet'));
    const outside = path.join(tmpdir(), 'outside-test.txt');
    writeFileSync(outside, 'outside');
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: String(input), options: options ?? {} });
      return Response.json({ ok: true, archive_id: 'a0000000-0000-4000-8000-000000000001' });
    }) as unknown as typeof fetch;
    const server = createEmployeeMcpServer({ baseUrl: 'https://example.test',
      token: financeKey, uploadRoot: root }, fetcher);
    const client = new Client({ name: 'workbuddy-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        'archive_local_file', 'get_archive_status', 'get_my_daily_report', 'submit_daily_report',
      ]);
      const blocked = await client.callTool({ name: 'archive_local_file', arguments: { file_path: outside } });
      expect(blocked.isError).toBe(true);
      expect(calls).toHaveLength(0);
      const uploaded = await client.callTool({ name: 'archive_local_file', arguments: { file_path: file } });
      expect(uploaded.isError).not.toBe(true);
      expect(calls[0].url).toBe('https://example.test/api/v1/employee/archives');
      expect(calls[0].options.body).toBeInstanceOf(FormData);
      const formFile = (calls[0].options.body as FormData).get('file') as File;
      expect(await formFile.text()).toBe('fictional spreadsheet');
    } finally {
      await client.close(); await server.close();
    }
  });
});
