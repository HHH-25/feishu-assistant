/** 仅用于隔离测试租户；所有姓名与业务内容均为虚构。 */
export function syntheticDailyRows(businessDate: string): Array<{
  kind: 'expected' | 'daily'; testCaseId: string; fields: Record<string, string>;
}> {
  const date = new Date(`${businessDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) ||
      Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== businessDate) {
    throw new Error('business_date 格式应为有效的 YYYY-MM-DD');
  }
  const expected = ['员工A', '员工B', '员工C', '员工D'].map((employee, index) => ({
    kind: 'expected' as const,
    testCaseId: `seed:${businessDate}:expected_${index + 1}`,
    fields: { business_date: businessDate, employee, active: 'true' },
  }));
  const report = (code: string, employee: string, hour: string, status: string,
    confidentiality: string, done: string): {
    kind: 'daily'; testCaseId: string; fields: Record<string, string>;
  } => ({
    kind: 'daily', testCaseId: `seed:${businessDate}:${code}`,
    fields: {
      date: businessDate, employee, department: employee === '员工D' ? '财务' : '销售',
      submitted_at: `${businessDate}T${hour}:00+08:00`, done_today: done,
      metrics: employee === '员工A' ? '虚构客户拜访 2 次' : '',
      unfinished: employee === '员工B' ? '演示环境联调未完' : '',
      problems: employee === '员工B' ? '等待测试权限' : '',
      tomorrow_plan: '继续完成演示任务', need_help: '', need_boss_decision: '',
      submit_status: status, confidentiality,
    },
  });
  return [
    ...expected,
    report('report_A', '员工A', '17:30', 'valid', 'dept', '完成虚构客户拜访'),
    report('report_B', '员工B', '18:10', 'late', 'dept', '推进演示项目交付'),
    report('report_A_duplicate', '员工A', '18:20', 'duplicate', 'dept', '重复提交演示'),
    report('report_D_finance', '员工D', '17:45', 'valid', 'finance', '核对虚构财务数据'),
  ];
}
