import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { RealFeishuClient } from '../src/clients/feishuReal.js';
import { MockModelClient } from '../src/clients/model.js';
import { config } from '../src/config.js';
import { syntheticDailyRows } from '../src/demo/syntheticDaily.js';
import { shanghaiBusinessDate } from '../src/services/scheduler.js';
import { StateStore } from '../src/state.js';
import type { SendMessageResult, UploadResult } from '../src/types.js';

const scenario = process.argv[2];
const businessDate = process.argv[3];
if (process.env.FEISHU_TEST_RECOVERY_ALLOWED !== 'true' ||
    config.clientMode !== 'real' || config.modelMode !== 'mock' ||
    config.feishu.appId !== 'cli_aa5a0c7cd0f5dc14' ||
    !['upload', 'message'].includes(scenario) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(businessDate ?? '') ||
    businessDate === shanghaiBusinessDate()) {
  throw new Error('仅允许独立测试应用、模拟模型、非当日日期运行 T9 故障演练');
}

type Credential = { key: string; operator: string; spaces: string[]; can_run_summary: boolean };
const credentials = JSON.parse(config.apiActorsJson) as Credential[];
const normal = credentials.find((item) => item.operator === 'user:normal-test' &&
  item.spaces.includes('space_public_test'));
const manager = credentials.find((item) => item.can_run_summary &&
  item.spaces.includes('space_public_test'));
if (!normal || !manager) throw new Error('缺少隔离测试租户的普通或管理 API 身份');
const normalActor: Credential = normal;
const managerActor: Credential = manager;

class LostResponseClient extends RealFeishuClient {
  uploaded?: UploadResult;
  sent?: SendMessageResult;
  uploadCalls = 0;
  sendCalls = 0;
  loseUploadResponse = false;
  loseMessageResponse = false;

  override async uploadFile(params: { fileName: string; buffer: Buffer; spaceId: string }) {
    this.uploadCalls++;
    const result = await super.uploadFile(params);
    if (this.loseUploadResponse) {
      this.loseUploadResponse = false;
      this.uploaded = result;
      throw new Error('T9 测试注入：真实上传成功后丢弃响应');
    }
    return result;
  }

  override async sendMessage(params: { chatId: string; text: string }) {
    this.sendCalls++;
    const result = await super.sendMessage(params);
    if (this.loseMessageResponse) {
      this.loseMessageResponse = false;
      this.sent = result;
      throw new Error('T9 测试注入：真实发送成功后丢弃响应');
    }
    return result;
  }
}

const feishu = new LostResponseClient();
const state = new StateStore();
const { app } = createApp({ feishu, model: new MockModelClient(), state });
const api = request(app);

async function verifyUpload() {
  const fileName = `t9-response-loss-${businessDate}.txt`;
  const buffer = Buffer.from(`Fictional T9 upload response loss; business date ${businessDate}\n`);
  const hash = createHash('sha256').update(buffer).digest('hex');
  const key = `hash:${hash}|space:space_public_test`;
  if (await feishu.findLedgerByHash(hash, 'space_public_test') || state.getUpload(key)) {
    throw new Error('此演练文件或回执已存在；停止以免重复上传');
  }
  const upload = () => api.post('/api/v1/archives')
    .set('authorization', `Bearer ${normalActor.key}`)
    .set('x-request-id', randomUUID())
    .field('department', '销售')
    .field('confidentiality', 'public')
    .field('space_id', 'space_public_test')
    .attach('file', buffer, fileName);
  feishu.loseUploadResponse = true;
  const first = await upload();
  const uncertain = state.getUpload(key);
  const failed = await feishu.findLedgerByHash(hash, 'space_public_test');
  if (first.status !== 503 || uncertain?.state !== 'uncertain' ||
      !feishu.uploaded?.file_id || failed?.status !== 'failed') {
    throw new Error('真实上传后的待核对状态不符合预期');
  }
  const second = await upload();
  if (second.status !== 409 || second.body.error?.code !== 'UPLOAD_UNCERTAIN' ||
      feishu.uploadCalls !== 1) {
    throw new Error('待核对上传未阻止第二次真实上传');
  }
  const reconciled = await api.post('/api/v1/recovery/upload')
    .set('authorization', `Bearer ${managerActor.key}`)
    .send({ archive_key: key, file_id: feishu.uploaded.file_id,
      feishu_url: feishu.uploaded.feishu_url });
  if (reconciled.status !== 200 || reconciled.body.upload?.state !== 'uploaded') {
    throw new Error('上传人工核对接口未保存真实文件标识');
  }
  const third = await upload();
  const done = await feishu.findLedgerByHash(hash, 'space_public_test');
  if (third.status !== 200 || done?.status !== 'success' ||
      done.file_id !== feishu.uploaded.file_id || feishu.uploadCalls !== 1) {
    throw new Error('核对后未复用真实文件完成台账');
  }
  console.log(JSON.stringify({ scenario: 'upload_response_lost', business_date: businessDate,
    first_status: first.status, blocked_status: second.status,
    reconcile_status: reconciled.status, final_status: third.status,
    archive_id: done.archive_id, file_id: done.file_id, upload_calls: feishu.uploadCalls,
    ledger_status: done.status }));
}

async function verifyMessage() {
  const [job, summary] = await Promise.all([
    feishu.getJobRunByKey(`daily_summary:${businessDate}`),
    feishu.getSummaryByDate(businessDate),
  ]);
  if (job || summary || state.getSend(businessDate)) {
    throw new Error('此日期已有汇总、任务或发送回执；停止以免重复推送');
  }
  for (const row of syntheticDailyRows(businessDate)) {
    await feishu.upsertTestRecord(row.kind, row.testCaseId, row.fields);
  }
  const run = () => api.post('/api/v1/daily-summary/run')
    .set('authorization', `Bearer ${managerActor.key}`)
    .set('x-request-id', randomUUID())
    .send({ business_date: businessDate });
  feishu.loseMessageResponse = true;
  const first = await run();
  const uncertain = state.getSend(businessDate);
  if (first.status !== 500 || uncertain?.state !== 'uncertain' ||
      !feishu.sent?.message_id || feishu.sendCalls !== 1) {
    throw new Error('真实发送后的待核对状态不符合预期');
  }
  const second = await run();
  if (second.status !== 409 || second.body.error?.code !== 'SEND_UNCERTAIN' ||
      feishu.sendCalls !== 1) {
    throw new Error('待核对消息未阻止第二次真实发送');
  }
  const reconciled = await api.post('/api/v1/recovery/message')
    .set('authorization', `Bearer ${managerActor.key}`)
    .send({ business_date: businessDate,
      delivered_message_id: feishu.sent.message_id });
  if (reconciled.status !== 200 || reconciled.body.send?.state !== 'sent') {
    throw new Error('消息人工核对接口未保存已送达回执');
  }
  const third = await run();
  const [doneJob, doneSummary] = await Promise.all([
    feishu.getJobRunByKey(`daily_summary:${businessDate}`),
    feishu.getSummaryByDate(businessDate),
  ]);
  if (third.status !== 200 || third.body.message_sent !== false ||
      !third.body.idempotent_skip_send || feishu.sendCalls !== 1 ||
      doneJob?.status !== 'success' || doneJob.message_id !== feishu.sent.message_id ||
      doneSummary?.message_id !== feishu.sent.message_id) {
    throw new Error('核对后未形成成功记录，或重复发送了消息');
  }
  console.log(JSON.stringify({ scenario: 'message_response_lost', business_date: businessDate,
    first_status: first.status, blocked_status: second.status,
    reconcile_status: reconciled.status, final_status: third.status,
    message_id: feishu.sent.message_id, send_calls: feishu.sendCalls,
    job_status: doneJob.status, summary_revision: doneSummary.revision }));
}

try {
  if (scenario === 'upload') await verifyUpload();
  else await verifyMessage();
} finally {
  state.close();
}
