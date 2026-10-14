import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { createClients } from '../src/clients/factory.js';
import { createApp } from '../src/app.js';
import { sha256 } from '../src/services/archive.js';

describe('REST 可演示（mock）', () => {
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(() => {
    process.env.CLIENT_MODE = 'mock';
    const clients = createClients('mock');
    ({ app } = createApp(clients));
  });

  it('健康检查含 mode', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mode).toBe('mock');
  });

  it('归档 → 查状态 → 同哈希去重', async () => {
    const content = Buffer.from('rest-demo-archive');
    const up = await request(app)
      .post('/api/v1/archives')
      .field('department', '销售')
      .field('confidentiality', 'dept')
      .field('space_id', 'space_sales')
      .field('operator', 'user:alice')
      .attach('file', content, 'demo.txt');

    expect(up.status).toBe(200);
    expect(up.body.ok).toBe(true);
    expect(up.body.status).toBe('success');
    expect(up.body.content_hash).toBe(sha256(content));
    expect(up.body.archive_key).toContain('space:space_sales');

    const get = await request(app).get(`/api/v1/archives/${up.body.archive_id}`);
    expect(get.status).toBe(200);
    expect(get.body.archive.status).toBe('success');

    const dup = await request(app)
      .post('/api/v1/archives')
      .field('department', '销售')
      .field('confidentiality', 'dept')
      .field('space_id', 'space_sales')
      .field('operator', 'user:bob')
      .attach('file', content, 'demo-copy.txt');
    expect(dup.body.deduplicated).toBe(true);
    expect(dup.body.status).toBe('duplicate');
  });

  it('普通用户归档财务空间 403', async () => {
    const res = await request(app)
      .post('/api/v1/archives')
      .field('department', '财务')
      .field('confidentiality', 'finance')
      .field('space_id', 'space_finance_test')
      .field('operator', 'user:alice')
      .attach('file', Buffer.from('x'), '预算.xlsx');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_SPACE');
  });

  it('种子日报 → 汇总 → 同日幂等不二次推送', async () => {
    const date = '2026-10-14';
    const seed = await request(app)
      .post('/api/v1/mock/seed-daily')
      .send({ business_date: date });
    expect(seed.status).toBe(200);
    expect(seed.body.expected).toContain('员工C');

    const first = await request(app)
      .post('/api/v1/daily-summary/run')
      .send({ business_date: date, operator: 'admin' });
    expect(first.status).toBe(200);
    expect(first.body.missing).toEqual(['员工C']);
    expect(first.body.message_sent).toBe(true);
    expect(first.body.revision).toBe(1);

    const second = await request(app)
      .post('/api/v1/daily-summary/run')
      .send({ business_date: date, operator: 'admin' });
    expect(second.body.message_sent).toBe(false);
    expect(second.body.idempotent_skip_send).toBe(true);
    expect(second.body.revision).toBe(2);
  });

  it('调度状态接口可读', async () => {
    const res = await request(app).get('/api/v1/daily-summary/schedule');
    expect(res.status).toBe(200);
    expect(res.body.schedule.cron_expr).toBe('0 20 * * *');
    expect(res.body.schedule.timezone).toBeTruthy();
  });
});
