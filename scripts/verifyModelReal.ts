import { config } from '../src/config.js';
import { RealModelClient } from '../src/clients/model.js';
import type { DailyReport } from '../src/types.js';

if (config.modelMode !== 'real' || config.model.provider !== 'deepseek') {
  throw new Error('此检查需 MODEL_MODE=real 且 MODEL_PROVIDER=deepseek');
}
if (!config.model.apiKey) throw new Error('MODEL_API_KEY 未配置');

const date = '2026-10-19';
const report: DailyReport = {
  record_id: 'rec_synthetic_model_check', date, employee: '虚构员工A', department: '测试部',
  submitted_at: `${date}T18:00:00+08:00`, done_today: '完成虚构项目的测试清单',
  metrics: '检查 3 项，完成 2 项', unfinished: '剩余 1 项明日处理',
  problems: '等待虚构审批', tomorrow_plan: '完成剩余检查', need_help: '',
  need_boss_decision: '确认虚构测试排期', submit_status: 'valid', confidentiality: 'dept',
};
const output = await new RealModelClient().summarizeDaily({
  businessDate: date, reports: [report], missingEmployees: ['虚构员工C'],
});
if (!output.content.includes(report.record_id) || !output.content.includes('虚构员工C')) {
  throw new Error('模型输出缺少来源记录或缺交人员');
}
process.stdout.write(`${JSON.stringify({ provider: config.model.provider, model: config.model.modelName,
  response_received: true, source_record_present: true, missing_employee_present: true })}\n`);
