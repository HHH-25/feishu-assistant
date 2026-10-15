import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import request from 'supertest';

const actorKey = 'test-key-with-at-least-24-characters';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('真实模式入口身份与空间权限', () => {
  it('拒绝无凭证、伪造操作者和未授权财务空间', async () => {
    vi.stubEnv('CLIENT_MODE', 'real');
    vi.stubEnv('API_ACTORS_JSON', JSON.stringify([{
      key: actorKey,
      operator: 'user:alice',
      spaces: ['space_sales'],
      can_run_summary: false,
      finance: false,
    }]));
    const { authenticate, authorizeSpace, authorizeSummary } = await import('../src/auth.js');
    const request = (authorization?: string) => ({
      header: (name: string) => name === 'authorization' ? authorization : undefined,
      body: { operator: 'finance:cfo' },
    } as unknown as Request);

    expect(() => authenticate(request())).toThrow(/凭证/);
    expect(() => authenticate(request('Bearer invalid-key'))).toThrow(/凭证/);
    const actor = authenticate(request(`Bearer ${actorKey}`));
    expect(actor.operator).toBe('user:alice');
    expect(() => authorizeSpace(actor, 'space_sales', 'dept')).not.toThrow();
    expect(() => authorizeSpace(actor, 'space_finance_test', 'finance')).toThrow(/无权/);
    expect(() => authorizeSummary(actor)).toThrow(/无权/);
  });

  it('REST 归档查询使用凭证身份并拒绝越权读取', async () => {
    vi.stubEnv('CLIENT_MODE', 'real');
    vi.stubEnv('API_ACTORS_JSON', JSON.stringify([
      { key: actorKey, operator: 'user:alice', spaces: ['space_sales'], can_run_summary: false, finance: false },
      { key: 'finance-key-with-at-least-24-characters', operator: 'user:cfo', spaces: ['space_finance_test'], can_run_summary: true, finance: true },
    ]));
    const { createApp } = await import('../src/app.js');
    const { MockFeishuClient } = await import('../src/clients/feishu.js');
    const { MockModelClient } = await import('../src/clients/model.js');
    const feishu = new MockFeishuClient();
    const { app } = createApp({ feishu, model: new MockModelClient() });
    const financeKey = 'finance-key-with-at-least-24-characters';
    const uploaded = await request(app).post('/api/v1/archives')
      .set('Authorization', `Bearer ${financeKey}`)
      .field('operator', 'user:alice')
      .field('department', '财务').field('confidentiality', 'finance')
      .field('space_id', 'space_finance_test')
      .attach('file', Buffer.from('mock budget'), 'budget.txt');
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.uploader).toBe('user:cfo');

    const denied = await request(app).get(`/api/v1/archives/${uploaded.body.archive_id}`)
      .set('Authorization', `Bearer ${actorKey}`);
    expect(denied.status).toBe(403);
    expect((await feishu.listAudits()).some((entry) =>
      entry.action === 'archive_read' && entry.result === 'deny' && entry.operator === 'user:alice')).toBe(true);
  });
});
