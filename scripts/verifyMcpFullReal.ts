import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { config } from '../src/config.js';
import { RealFeishuClient } from '../src/clients/feishuReal.js';
import { dailySummaryIdempotentKey } from '../src/services/dailySummary.js';
import { shanghaiBusinessDate } from '../src/services/scheduler.js';

const businessDate = process.argv[2];
const revise = process.argv[3] === '--revise';
if (process.env.FEISHU_TEST_FULL_REAL_ALLOWED !== 'true' ||
    config.clientMode !== 'real' || config.model.provider !== 'deepseek' ||
    config.feishu.appId !== 'cli_aa5a0c7cd0f5dc14' || !config.model.apiKey) {
  throw new Error('仅允许在已核对的独立测试应用中，以真实 DeepSeek 运行此联调');
}
if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate) ||
    businessDate === shanghaiBusinessDate()) {
  throw new Error('请传入已准备的非当日测试业务日期，以免占用今日定时验收');
}

const feishu = new RealFeishuClient();
const previousSummary = await feishu.getSummaryByDate(businessDate);
const previousJob = await feishu.getJobRunByKey(dailySummaryIdempotentKey(businessDate));
if (!revise && (previousSummary || previousJob)) {
  throw new Error('该测试业务日已有汇总或任务记录，停止以避免重复或覆盖；修订请显式传 --revise');
}
if (revise && (!previousSummary?.message_id || previousJob?.status !== 'success')) {
  throw new Error('修订前必须有已成功推送的摘要和任务记录');
}
const actors = JSON.parse(config.apiActorsJson) as Array<{ key: string; can_run_summary: boolean }>;
const manager = actors.find((actor) => actor.can_run_summary);
if (!manager) throw new Error('未配置可触发汇总的可信身份');

const client = new Client({ name: 'real-full-chain-check', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', 'src/mcp/server.ts'],
  cwd: process.cwd(),
  env: { ...process.env, CLIENT_MODE: 'real', MODEL_MODE: 'real',
    MCP_API_KEY: manager.key } as Record<string, string>,
  stderr: 'pipe',
});
try {
  await client.connect(transport);
  const response = await client.callTool({
    name: 'trigger_daily_summary', arguments: { business_date: businessDate },
  });
  const text = response.content.find((part) => part.type === 'text')?.text;
  if (response.isError || !text) throw new Error(`真实 MCP 汇总失败：${text ?? '无返回内容'}`);
  const result = JSON.parse(text) as { summary_id: string; message_sent: boolean;
    idempotent_skip_send: boolean; revision: number; missing: string[] };
  const summary = await feishu.getSummaryByDate(businessDate);
  const job = await feishu.getJobRunByKey(dailySummaryIdempotentKey(businessDate));
  const reports = await feishu.listDailyReports(businessDate);
  const financeIds = new Set(reports.filter((report) => report.confidentiality === 'finance')
    .map((report) => report.record_id));
  const modelGeneratedBody = summary?.content.split('\n未提交人员：')[0] ?? '';
  if ((revise ? result.message_sent || !result.idempotent_skip_send : !result.message_sent) ||
      !result.missing.includes('员工C') ||
      !summary || summary.summary_id !== result.summary_id || !summary.message_id ||
      !job || job.status !== 'success' || job.message_id !== summary.message_id ||
      summary.source_report_ids.length !== 2 ||
      summary.source_report_ids.some((id) => financeIds.has(id)) ||
      modelGeneratedBody.includes('员工C') ||
      (revise && (summary.message_id !== previousSummary!.message_id ||
        summary.revision <= previousSummary!.revision))) {
    throw new Error('真实汇总结果、飞书记录或财务过滤校验失败');
  }
  process.stdout.write(`${JSON.stringify({ business_date: businessDate,
    summary_id: summary.summary_id, source_report_ids: summary.source_report_ids,
    missing: result.missing, message_id: summary.message_id, job_status: job.status,
    revision: summary.revision, message_sent: result.message_sent,
    idempotent_skip_send: result.idempotent_skip_send, finance_excluded: true })}\n`);
} finally {
  await client.close();
}
