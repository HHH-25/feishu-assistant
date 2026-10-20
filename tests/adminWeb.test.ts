import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Script } from 'node:vm';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('飞书管理员网页入口', () => {
  it('飞书身份换取服务端会话后才可查询和操作，财务越权与跨站写入被拒绝', async () => {
    vi.stubEnv('CLIENT_MODE', 'real');
    vi.stubEnv('MODEL_MODE', 'mock');
    vi.stubEnv('ADMIN_WEB_ENABLED', 'true');
    vi.stubEnv('ADMIN_WEB_SESSION_SECRET', 'test-session-secret-at-least-32-characters-long');
    vi.stubEnv('ADMIN_WEB_ACTORS_JSON', JSON.stringify([{ open_id: 'ou_manager', operator: 'boss:manager',
      spaces: ['space_public_test'], can_run_summary: true, finance: false }]));
    vi.stubEnv('FEISHU_APP_ID', 'cli_test');
    vi.stubEnv('FEISHU_APP_SECRET', 'secret-only-on-server');
    vi.stubEnv('FEISHU_BASE_URL', 'https://feishu.test/open-apis');
    const calls: string[] = [];
    let returnedOpenId = 'ou_manager';
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const path = String(url); calls.push(path);
      if (path.endsWith('/auth/v3/app_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, app_access_token: 'app-token', expire: 7200 }));
      }
      if (path.endsWith('/authen/v1/access_token')) {
        return new Response(JSON.stringify({ code: 0, data: { access_token: 'user-token' } }));
      }
      if (path.endsWith('/authen/v1/user_info')) {
        return new Response(JSON.stringify({ code: 0, data: { open_id: returnedOpenId } }));
      }
      throw new Error(`unexpected URL ${path}`);
    }));
    const { createApp } = await import('../src/app.js');
    const { MockFeishuClient } = await import('../src/clients/feishu.js');
    const { MockModelClient } = await import('../src/clients/model.js');
    const feishu = new MockFeishuClient();
    const { app } = createApp({ feishu, model: new MockModelClient() });
    const page = await request(app).get('/admin');
    expect(page.status).toBe(200);
    expect(page.text).toContain('企业数据中心');
    expect(page.text).not.toContain('secret-only-on-server');
    const script = await request(app).get('/admin/app.js');
    expect(script.text).toContain('cli_test');
    expect(script.text).not.toContain('secret-only-on-server');
    expect(script.text).toContain("option.value=space");
    expect(() => new Script(script.text)).not.toThrow();
    expect((await request(app).get('/admin/api/archives')).status).toBe(401);
    const login = await request(app).post('/admin/auth')
      .set('Host', 'admin.test').set('Origin', 'https://admin.test').send({ code: 'one-time-code' });
    expect(login.status).toBe(200);
    expect(calls).toHaveLength(3);
    returnedOpenId = 'ou_unlisted';
    const unlisted = await request(app).post('/admin/auth')
      .set('Host', 'admin.test').set('Origin', 'https://admin.test').send({ code: 'another-code' });
    expect(unlisted.status).toBe(403);
    expect(unlisted.body.error.message).toContain('ou_unlisted');
    expect(unlisted.headers['set-cookie']).toBeUndefined();
    const cookie = login.headers['set-cookie'][0].split(';')[0] as string;
    const me = await request(app).get('/admin/api/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.operator).toBe('boss:manager');
    const csrf = me.body.csrf as string;
    expect((await request(app).get('/admin/api/me').set('Cookie', `${cookie}x`)).status).toBe(401);

    const crossSite = await request(app).post('/admin/api/archives')
      .set('Host', 'admin.test').set('Origin', 'https://evil.test')
      .set('Cookie', cookie).set('x-csrf-token', csrf)
      .field('department', '销售').field('space_id', 'space_public_test')
      .field('confidentiality', 'dept').attach('file', Buffer.from('x'), 'test.txt');
    expect(crossSite.status).toBe(403);
    const noCsrf = await request(app).post('/admin/api/archives')
      .set('Host', 'admin.test').set('Origin', 'https://admin.test').set('Cookie', cookie)
      .field('department', '销售').field('space_id', 'space_public_test')
      .field('confidentiality', 'dept').attach('file', Buffer.from('x'), 'test.txt');
    expect(noCsrf.status).toBe(403);
    expect(await feishu.listLedgers()).toHaveLength(0);

    const saved = await request(app).post('/admin/api/archives')
      .set('Host', 'admin.test').set('Origin', 'https://admin.test')
      .set('Cookie', cookie).set('x-csrf-token', csrf)
      .field('department', '销售').field('space_id', 'space_public_test')
      .field('confidentiality', 'dept').attach('file', Buffer.from('hello'), 'report.txt');
    expect(saved.status).toBe(200);
    const publicRecord = await feishu.getLedger(saved.body.archive_id);
    expect(publicRecord).toBeTruthy();
    await feishu.writeLedger({ ...publicRecord!, archive_id: 'finance-hidden',
      file_name: 'finance-report.txt', space_id: 'space_finance_test', confidentiality: 'finance',
      content_hash: 'another-hash', archive_key: 'hash:another-hash|space:space_finance_test' });
    const list = await request(app).get('/admin/api/archives?file_name=report').set('Cookie', cookie);
    expect(list.body.total).toBe(1);
    expect(list.body.archives[0].uploader).toBe('boss:manager');
    const denied = await request(app).post('/admin/api/archives')
      .set('Host', 'admin.test').set('Origin', 'https://admin.test')
      .set('Cookie', cookie).set('x-csrf-token', csrf)
      .field('department', '财务').field('space_id', 'space_finance_test')
      .field('confidentiality', 'finance').attach('file', Buffer.from('budget'), 'budget.txt');
    expect(denied.status).toBe(403);
    expect((await feishu.listAudits()).some((audit) => audit.action === 'archive_web' && audit.result === 'deny')).toBe(true);

    const summary = await request(app).post('/admin/api/daily-summary')
      .set('Host', 'admin.test').set('Origin', 'https://admin.test')
      .set('Cookie', cookie).set('x-csrf-token', csrf)
      .send({ business_date: '2026-10-19' });
    expect(summary.status).toBe(200);
    const status = await request(app).get('/admin/api/daily-summary/2026-10-19').set('Cookie', cookie);
    expect(status.body.job.status).toBe('success');
    expect(status.body.summary.content).toContain('管理日报摘要');
    expect(status.body.summary.summary_id).toBe(summary.body.summary_id);
  });
});
