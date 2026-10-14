import type { MockFeishuClient } from '../clients/feishu.js';
import type { DailyReport } from '../types.js';

/** Mock HTTP 演示用：A/B 已交、C 缺交，含风险与决策字段 */
export function seedDemoDailyReports(
  feishu: MockFeishuClient,
  businessDate: string,
): { expected: string[]; reports: DailyReport[] } {
  const expected = ['员工A', '员工B', '员工C'];
  const reports: DailyReport[] = [
    {
      record_id: `demo_${businessDate}_A`,
      date: businessDate,
      employee: '员工A',
      department: '销售',
      submitted_at: `${businessDate}T17:30:00+08:00`,
      done_today: '完成两家客户拜访并更新 CRM',
      metrics: '意向客户 +2',
      unfinished: '',
      problems: '',
      tomorrow_plan: '跟进报价',
      need_help: '',
      need_boss_decision: '',
      submit_status: 'valid',
    },
    {
      record_id: `demo_${businessDate}_B`,
      date: businessDate,
      employee: '员工B',
      department: '交付',
      submitted_at: `${businessDate}T18:10:00+08:00`,
      done_today: '推进测试环境联调',
      metrics: '用例通过率 92%',
      unfinished: '性能压测未完成',
      problems: '测试环境间歇不稳定',
      tomorrow_plan: '补齐压测报告',
      need_help: '需要运维协助扩容',
      need_boss_decision: '是否追加一台测试机',
      submit_status: 'valid',
    },
  ];
  feishu.seedDaily(businessDate, expected, reports);
  return { expected, reports };
}
