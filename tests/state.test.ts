import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from '../src/state.js';
import { MockFeishuClient } from '../src/clients/feishu.js';
import { MockModelClient } from '../src/clients/model.js';
import { ArchiveService } from '../src/services/archive.js';
import { DailySummaryService } from '../src/services/dailySummary.js';
import { sha256 } from '../src/services/archive.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('持久化恢复状态', () => {
  it('进程重启后保留发送不确定状态，并阻止第二个进程获取同一锁', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feishu-state-'));
    dirs.push(dir);
    const file = join(dir, 'state.db');
    const first = new StateStore(file);
    const second = new StateStore(file);
    const owner = first.acquire('summary:2026-10-14');
    expect(owner).toBeTruthy();
    expect(second.acquire('summary:2026-10-14')).toBeNull();
    expect(first.beginSend('2026-10-14')).toBe(true);
    first.close();
    expect(second.getSend('2026-10-14')?.state).toBe('sending');
    expect(second.beginSend('2026-10-14')).toBe(false);
    second.markSendUncertain('2026-10-14');
    expect(second.getSend('2026-10-14')?.state).toBe('uncertain');
    second.reconcileSend('2026-10-14', 'msg-confirmed');
    expect(second.getSend('2026-10-14')).toEqual({ state: 'sent', message_id: 'msg-confirmed' });
    second.release('summary:2026-10-14', owner!);
    second.close();
  });

  it('上传回执在重启后保留文件标识供重试', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feishu-state-'));
    dirs.push(dir);
    const file = join(dir, 'state.db');
    const first = new StateStore(file);
    expect(first.beginUpload('hash:abc|space:sales')).toBe(true);
    first.recordUpload('hash:abc|space:sales', 'file-1', 'https://example.test/file-1');
    first.close();
    const second = new StateStore(file);
    expect(second.getUpload('hash:abc|space:sales')).toEqual({ state: 'uploaded',
      file_id: 'file-1', feishu_url: 'https://example.test/file-1' });
    second.close();
  });

  it('发送响应丢失后跨实例暂停重发，核对已送达后仅修订摘要', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feishu-state-')); dirs.push(dir);
    const file = join(dir, 'state.db');
    const feishu = new MockFeishuClient();
    const date = '2026-10-14';
    feishu.seedDaily(date, ['员工A'], [{ record_id: 'rec-A', date, employee: '员工A', department: '销售',
      submitted_at: `${date}T18:00:00+08:00`, done_today: '完成拜访', metrics: '', unfinished: '',
      problems: '', tomorrow_plan: '', need_help: '', need_boss_decision: '', submit_status: 'valid' }]);
    const originalSend = feishu.sendMessage.bind(feishu);
    let sendCalls = 0;
    feishu.sendMessage = async (params) => {
      sendCalls++;
      await originalSend(params);
      throw new Error('响应在送达后丢失');
    };
    const firstState = new StateStore(file);
    await expect(new DailySummaryService(feishu, new MockModelClient(), firstState)
      .run({ businessDate: date, operator: 'admin', requestId: 'first' })).rejects.toThrow();
    expect(firstState.getSend(date)?.state).toBe('uncertain');
    expect(sendCalls).toBe(1);
    firstState.close();

    const secondState = new StateStore(file);
    const second = new DailySummaryService(feishu, new MockModelClient(), secondState);
    await expect(second.run({ businessDate: date, operator: 'admin', requestId: 'second' }))
      .rejects.toMatchObject({ code: 'SEND_UNCERTAIN' });
    expect(sendCalls).toBe(1);
    secondState.reconcileSend(date, feishu.getMessages()[0].message_id);
    const result = await second.run({ businessDate: date, operator: 'admin', requestId: 'third' });
    expect(result.idempotent_skip_send).toBe(true);
    expect(sendCalls).toBe(1);
    secondState.close();
  });

  it('上传结果未知时暂停重传，人工确认未上传后可恢复', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feishu-state-')); dirs.push(dir);
    const file = join(dir, 'state.db');
    const feishu = new MockFeishuClient();
    const input = { fileName: 'a.txt', buffer: Buffer.from('payload'), department: '销售',
      confidentiality: 'dept' as const, spaceId: 'space_sales', operator: 'user:alice' };
    const key = `hash:${sha256(input.buffer)}|space:${input.spaceId}`;
    const originalUpload = feishu.uploadFile.bind(feishu);
    let uploadCalls = 0;
    feishu.uploadFile = async (params) => {
      uploadCalls++;
      if (uploadCalls === 1) throw new Error('上传响应丢失');
      return originalUpload(params);
    };
    const firstState = new StateStore(file);
    await expect(new ArchiveService(feishu, firstState).archive(input, 'first')).rejects.toThrow();
    expect(firstState.getUpload(key)?.state).toBe('uncertain');
    firstState.close();
    const secondState = new StateStore(file);
    const second = new ArchiveService(feishu, secondState);
    await expect(second.archive(input, 'second')).rejects.toMatchObject({ code: 'UPLOAD_UNCERTAIN' });
    expect(uploadCalls).toBe(1);
    secondState.reconcileUpload(key);
    const result = await second.archive(input, 'third');
    expect(result.status).toBe('success');
    expect(uploadCalls).toBe(2);
    secondState.close();
  });

  it('上传后台账连续故障，重启后凭持久回执复用文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feishu-state-')); dirs.push(dir);
    const file = join(dir, 'state.db');
    const feishu = new MockFeishuClient();
    const input = { fileName: 'recovery.txt', buffer: Buffer.from('persist receipt'),
      department: '销售', confidentiality: 'dept' as const,
      spaceId: 'space_sales', operator: 'user:alice' };
    const originalUpload = feishu.uploadFile.bind(feishu);
    const originalWrite = feishu.writeLedger.bind(feishu);
    let uploadCalls = 0;
    let failAfterUpload = true;
    feishu.uploadFile = async (params) => { uploadCalls++; return originalUpload(params); };
    feishu.writeLedger = async (record) => {
      if (failAfterUpload && record.file_id) throw new Error('台账不可写');
      return originalWrite(record);
    };
    const firstState = new StateStore(file);
    await expect(new ArchiveService(feishu, firstState).archive(input, 'first'))
      .rejects.toMatchObject({ code: 'UPSTREAM' });
    expect(firstState.getUpload(`hash:${sha256(input.buffer)}|space:space_sales`)?.state).toBe('uploaded');
    firstState.close();
    failAfterUpload = false;
    const secondState = new StateStore(file);
    const result = await new ArchiveService(feishu, secondState).archive(input, 'second');
    expect(result.status).toBe('success');
    expect(uploadCalls).toBe(1);
    secondState.close();
  });
});
