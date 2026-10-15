import { config } from '../src/config.js';
import { RealFeishuClient } from '../src/clients/feishuReal.js';
import { syntheticDailyRows } from '../src/demo/syntheticDaily.js';
import { shanghaiBusinessDate } from '../src/services/scheduler.js';

if (config.clientMode !== 'real' || process.env.FEISHU_TEST_SEED_ALLOWED !== 'true') {
  throw new Error('只允许在 CLIENT_MODE=real 且 FEISHU_TEST_SEED_ALLOWED=true 的隔离测试租户写入种子');
}

const businessDate = process.argv[2] ?? shanghaiBusinessDate();
const rows = syntheticDailyRows(businessDate);
const feishu = new RealFeishuClient();
const records = [];
for (const row of rows) {
  const recordId = await feishu.upsertTestRecord(row.kind, row.testCaseId, row.fields);
  records.push({ kind: row.kind, test_case_id: row.testCaseId, record_id: recordId });
}
process.stdout.write(`${JSON.stringify({ business_date: businessDate, records }, null, 2)}\n`);
