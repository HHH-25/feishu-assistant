import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ApiActor } from '../src/auth.js';
import { MockFeishuClient } from '../src/clients/feishu.js';
import { FeishuWikiClient, type WikiGateway, type WikiNode } from '../src/clients/wiki.js';
import { WikiService, type WikiTarget } from '../src/services/wiki.js';
import { StateStore } from '../src/state.js';

const target: WikiTarget = { id: 'public_demo', name: '虚构测试库', space_id: '123',
  parent_node_token: 'home', staging_space_id: 'wiki_staging', url_origin: 'https://test.feishu.cn' };
const actor: ApiActor = { kind: 'employee', operator: 'finance:hyh', employee: 'hyh', department: '财务',
  spaces: ['finance'], default_space_id: 'finance', default_confidentiality: 'finance', finance: true,
  can_run_summary: false, wiki_read_targets: ['public_demo'], wiki_write_targets: ['public_demo'] };
const parent: WikiNode = { node_token: 'home', obj_token: 'homeDoc', obj_type: 'docx', space_id: '123', title: '首页', node_type: 'origin' };
const created = { ...parent, node_token: 'newNode', obj_token: 'newDoc', title: '你好' };
const draft = { target: 'public_demo', title: '你好', content: '用户：你好\n助手：你好呀。', public_test_content: true as const };
function gateway(): WikiGateway {
  return { node: vi.fn(async (id) => id === 'home' ? parent : created),
    create: vi.fn(async () => created), append: vi.fn(async () => {}),
    read: vi.fn(async () => draft.content), list: vi.fn(async () => ({ items: [created] })),
    move: vi.fn(async () => ({ task_id: 'task1' })), task: vi.fn(async () => null) };
}
const stores: StateStore[] = [];
function store(file = path.join(mkdtempSync(path.join(tmpdir(), 'wiki-test-')), 'state.db')) {
  const state = new StateStore(file); stores.push(state); return { state, file };
}
afterEach(() => { for (const s of stores.splice(0)) s.close(); vi.unstubAllEnvs(); vi.resetModules(); });

describe('知识库授权和持久化', () => {
  it('文档创建、读取、重复提交和重启后不重复创建', async () => {
    const { state, file } = store(); const api = gateway(); const feishu = new MockFeishuClient();
    const service = new WikiService(feishu, api, state, [target]);
    const first = await service.publish(actor, draft, 'req1');
    expect(first).toMatchObject({ status: 'success', node_token: 'newNode', audit_pending: false });
    expect(first.url).toBe('https://test.feishu.cn/wiki/newNode');
    const restarted = new WikiService(feishu, api, store(file).state, [target]);
    expect((await restarted.publish(actor, draft, 'req2')).operation_id).toBe(first.operation_id);
    expect(api.create).toHaveBeenCalledTimes(1); expect(api.append).toHaveBeenCalledTimes(1);
    expect((await restarted.read(actor, 'public_demo', 'newNode', 'req3')).content).toBe(draft.content);
    expect(await feishu.listAudits()).toEqual(expect.arrayContaining([expect.objectContaining({
      operator: 'finance:hyh', action: 'wiki_publish', result: 'success' })]));
  });

  it('财务身份本身不授予公开库写权限；跨库和快捷方式拒绝读取且审计', async () => {
    const api = gateway(); const feishu = new MockFeishuClient();
    const service = new WikiService(feishu, api, store().state, [target]);
    await expect(service.publish({ ...actor, wiki_write_targets: [] }, draft, 'deny')).rejects.toThrow('未获');
    expect(api.create).not.toHaveBeenCalled();
    vi.mocked(api.node).mockResolvedValue({ ...created, space_id: 'secret' });
    await expect(service.read(actor, 'public_demo', 'secretNode', 'deny2')).rejects.toThrow('不在');
    vi.mocked(api.node).mockResolvedValue({ ...created, node_type: 'shortcut' });
    await expect(service.read(actor, 'public_demo', 'shortcut', 'deny3')).rejects.toThrow('快捷');
    expect(api.read).not.toHaveBeenCalled();
    expect((await feishu.listAudits()).filter((a) => a.result === 'deny')).toHaveLength(3);
  });

  it('正文写入响应丢失保留节点，重启后不重复创建或追加', async () => {
    const { state, file } = store(); const api = gateway(); const feishu = new MockFeishuClient();
    vi.mocked(api.append).mockRejectedValue(new Error('response lost'));
    const first = await new WikiService(feishu, api, state, [target]).publish(actor, draft, 'r1');
    expect(first).toMatchObject({ status: 'uncertain', node_token: 'newNode', stage: 'writing' });
    const service = new WikiService(feishu, api, store(file).state, [target]);
    expect((await service.publish(actor, draft, 'r2')).status).toBe('uncertain');
    expect(api.create).toHaveBeenCalledTimes(1); expect(api.append).toHaveBeenCalledTimes(1);
    await expect(service.status({ ...actor, operator: 'other' }, first.operation_id, 'r3')).rejects.toThrow('本人');
  });

  it('文件上传响应丢失不重复上传；已知异步任务查询完成后才成功', async () => {
    const api = gateway(); const feishu = new MockFeishuClient(); const state = store().state;
    const service = new WikiService(feishu, api, state, [target]);
    const upload = vi.spyOn(feishu, 'uploadFile').mockRejectedValueOnce(new Error('response lost'));
    const input = { target: 'public_demo', title: 'test.txt', buffer: Buffer.from('虚构'), public_test_content: true as const };
    const lost = await service.publish(actor, input, 'r1');
    expect(lost.status).toBe('uncertain');
    await service.publish(actor, input, 'r2'); expect(upload).toHaveBeenCalledTimes(1);
    expect(api.move).not.toHaveBeenCalled();
    upload.mockResolvedValue({ file_id: 'newFile', feishu_url: 'https://test.feishu.cn/file/newFile' });
    const pending = await service.publish(actor, { ...input, title: 'another.txt' }, 'r3');
    expect(pending.status).toBe('pending'); expect(pending.task_id).toBe('task1');
    vi.mocked(api.task).mockResolvedValue({ ...created, obj_type: 'file', obj_token: 'newFile' });
    expect((await service.status(actor, pending.operation_id, 'r4')).status).toBe('success');
    expect(upload).toHaveBeenCalledTimes(2); expect(api.move).toHaveBeenCalledTimes(1);
  });

  it('审计失败不导致重建，查询仅补写审计；并发相同请求只有一次创建', async () => {
    const api = gateway(); const feishu = new MockFeishuClient();
    const audit = vi.spyOn(feishu, 'writeAudit').mockRejectedValueOnce(new Error('offline'));
    const service = new WikiService(feishu, api, store().state, [target]);
    const [a] = await Promise.all([service.publish(actor, draft, 'r1'), service.publish(actor, draft, 'r2')]);
    expect(api.create).toHaveBeenCalledTimes(1);
    const saved = await service.status(actor, a.operation_id, 'r3');
    expect(saved.status).toBe('success'); expect(saved.audit_pending).toBe(false);
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it('管理员核对已有节点恢复不确定结果，员工和其他节点不能冒充恢复', async () => {
    const api = gateway(); const feishu = new MockFeishuClient();
    vi.mocked(api.append).mockRejectedValue(new Error('response lost'));
    const service = new WikiService(feishu, api, store().state, [target]);
    const saved = await service.publish(actor, draft, 'r1');
    await expect(service.reconcile(actor, saved.operation_id, 'newNode', 'r2')).rejects.toThrow('管理员');
    const admin = { ...actor, kind: undefined, operator: 'admin:test', can_run_summary: true };
    await expect(service.reconcile(admin, saved.operation_id, 'otherNode', 'r3')).rejects.toThrow('不一致');
    const reconciled = await service.reconcile(admin, saved.operation_id, 'newNode', 'r4');
    expect(reconciled).toMatchObject({ status: 'success', stage: 'manually_verified' });
    expect(api.create).toHaveBeenCalledTimes(1); expect(api.append).toHaveBeenCalledTimes(1);
    expect((await feishu.listAudits()).at(-1)).toMatchObject({ operator: 'admin:test', action: 'wiki_reconcile' });
  });

  it('配置的首页不属于目标库时零写入，调整配置后允许正常尝试', async () => {
    const api = gateway(); const feishu = new MockFeishuClient();
    const service = new WikiService(feishu, api, store().state, [target]);
    vi.mocked(api.node).mockResolvedValueOnce({ ...parent, space_id: 'wrong' });
    await expect(service.publish(actor, draft, 'r1')).rejects.toThrow('不在');
    expect(api.create).not.toHaveBeenCalled();
    expect((await service.publish(actor, draft, 'r2')).status).toBe('success');
  });

  it('管理员核对所有分页无同名节点后允许一次重试，保留历史且并发不重建', async () => {
    const api = gateway(); const feishu = new MockFeishuClient(); const state = store().state;
    vi.mocked(api.create).mockRejectedValueOnce(new Error('code=131006'));
    const service = new WikiService(feishu, api, state, [target]);
    const failed = await service.publish(actor, draft, 'r1');
    const admin = { ...actor, kind: undefined, operator: 'admin:test', can_run_summary: true };
    await expect(service.authorizeCreateRetry(actor, failed.operation_id, 'r2')).rejects.toThrow('管理员');
    await expect(service.authorizeCreateRetry(admin, failed.operation_id, 'r3')).rejects.toThrow('五分钟');
    failed.updated_at = new Date(Date.now() - 600_000).toISOString(); state.saveWiki(failed.operation_id, failed);
    await expect(service.authorizeCreateRetry(admin, failed.operation_id, 'r4')).rejects.toThrow('同名');
    vi.mocked(api.list).mockResolvedValueOnce({ items: [], next: 'page2' }).mockResolvedValueOnce({ items: [] });
    await service.authorizeCreateRetry(admin, failed.operation_id, 'r5');
    await Promise.all([service.publish(actor, draft, 'r6'), service.publish(actor, draft, 'r7')]);
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(await service.status(actor, failed.operation_id, 'r8')).toMatchObject({
      status: 'success', recovery_history: [{ operator: 'admin:test', failure_code: 'code=131006' }],
    });
  });

  it('REST 严格验证身份和参数，不允许注入空间、员工、已有财务文件ID', async () => {
    vi.stubEnv('WIKI_ENABLED', 'true'); vi.stubEnv('FEISHU_WIKI_TARGETS_JSON', JSON.stringify([target]));
    const key = 'dedicated-wiki-test-key-long-enough';
    vi.stubEnv('API_ACTORS_JSON', JSON.stringify([{ ...actor, key }]));
    const { createApp } = await import('../src/app.js');
    const { MockModelClient } = await import('../src/clients/model.js');
    const api = gateway(); const feishu = new MockFeishuClient();
    const { app } = createApp({ feishu, wiki: api, state: store().state, model: new MockModelClient() });
    const url = '/api/v1/employee/wiki/documents';
    expect((await request(app).post(url).send(draft)).status).toBe(401);
    expect((await request(app).post(url).set('Authorization', 'Bearer wrong').send(draft)).status).toBe(401);
    const auth = `Bearer ${key}`;
    for (const forged of [{ ...draft, employee: 'admin' }, { ...draft, space_id: 'secret' },
      { ...draft, public_test_content: false }]) {
      expect((await request(app).post(url).set('Authorization', auth).send(forged)).status).toBe(400);
    }
    expect((await request(app).post('/api/v1/employee/wiki/files').set('Authorization', auth)
      .field('target', 'public_demo').field('public_test_content', 'true').field('file_id', 'financeFile')).status).toBe(400);
    const ok = await request(app).post(url).set('Authorization', auth).send(draft);
    expect(ok.status).toBe(200); expect(ok.body.operation.status).toBe('success');
  });
});

describe('飞书 Wiki 适配器协议', () => {
  it('空库列表允许飞书省略 items，但非末页缺字段仍拒绝', async () => {
    const api = vi.fn(async (): Promise<Record<string, unknown>> => ({ has_more: false, page_token: '' }));
    const client = new FeishuWikiClient(api);
    expect(await client.list('123', 'home')).toEqual({ items: [], next: undefined });
    api.mockResolvedValueOnce({ has_more: true });
    await expect(client.list('123', 'home')).rejects.toThrow('分页');
  });
  it('创建、文本块、移入和任务查询使用官方API形状', async () => {
    const api = vi.fn(async (method: string, url: string, body?: unknown): Promise<Record<string, unknown>> => {
      if (url.includes('get_node')) return { node: created };
      if (url.includes('/tasks/')) return { task: { move_result: [{ status: 0, node: created }] } };
      if (url.includes('move_docs_to_wiki')) return { task_id: 'move1' };
      if (url.includes('/children')) return {};
      return { node: created };
    });
    const client = new FeishuWikiClient(api);
    await client.create('123', 'home', '你好'); await client.append('newDoc', '第一段\n第二段');
    expect(api).toHaveBeenCalledWith('POST', '/wiki/v2/spaces/123/nodes', {
      obj_type: 'docx', node_type: 'origin', parent_node_token: 'home', title: '你好' });
    expect(api).toHaveBeenCalledWith('POST', '/docx/v1/documents/newDoc/blocks/newDoc/children?document_revision_id=-1', {
      children: [{ block_type: 2, text: { elements: [{ text_run: { content: '第一段' } }] } },
        { block_type: 2, text: { elements: [{ text_run: { content: '第二段' } }] } }], index: -1 });
    expect(await client.move('123', 'home', 'file1')).toEqual({ wiki_token: undefined, task_id: 'move1' });
    expect(api).toHaveBeenCalledWith('POST', '/wiki/v2/spaces/123/nodes/move_docs_to_wiki', {
      parent_wiki_token: 'home', obj_type: 'file', obj_token: 'file1', apply: false });
    expect(await client.task('move1')).toMatchObject(created);
  });
});
