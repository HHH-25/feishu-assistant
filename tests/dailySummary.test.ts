import { describe, expect, it, beforeEach } from 'vitest';
import { MockFeishuClient } from '../src/clients/feishu.js';
import { MockModelClient } from '../src/clients/model.js';
import {
  DailySummaryService,
  findMissingEmployees,
  dailySummaryIdempotentKey,
} from '../src/services/dailySummary.js';
import { DailySummaryScheduler, isShanghaiHour, shanghaiBusinessDate } from '../src/services/scheduler.js';
import type { DailyReport } from '../src/types.js';

function report(partial: Partial<DailyReport> & Pick<DailyReport, 'employee' | 'date'>): DailyReport {
  return {
    record_id: partial.record_id ?? `rec_${partial.employee}`,
    date: partial.date,
    employee: partial.employee,
    department: partial.department ?? '交付',
    submitted_at: partial.submitted_at ?? `${partial.date}T18:00:00+08:00`,
    done_today: partial.done_today ?? '完成日常',
    metrics: partial.metrics ?? '',
    unfinished: partial.unfinished ?? '',
    problems: partial.problems ?? '',
    tomorrow_plan: partial.tomorrow_plan ?? '继续推进',
    need_help: partial.need_help ?? '',
    need_boss_decision: partial.need_boss_decision ?? '',
    submit_status: partial.submit_status ?? 'valid',
  };
}

describe('日报汇总闭环（T5–T8）', () => {
  let feishu: MockFeishuClient;
  let service: DailySummaryService;

  beforeEach(() => {
    feishu = new MockFeishuClient();
    service = new DailySummaryService(feishu, new MockModelClient());
  });

  it('T5 缺交识别：A/B 已交 C 未交；duplicate 不计入有效', async () => {
    expect(findMissingEmployees(['员工A', '员工B', '员工C'], ['员工A', '员工B'])).toEqual(['员工C']);

    const date = '2026-10-14';
    feishu.seedDaily(date, ['员工A', '员工B', '员工C'], [
      report({ employee: '员工A', date, done_today: '完成客户拜访', metrics: '签约 1' }),
      report({
        employee: '员工B',
        date,
        done_today: '推进交付',
        problems: '环境不稳定',
        need_boss_decision: '是否追加测试资源',
      }),
      report({
        employee: '员工A',
        date,
        record_id: 'rec_员工A_dup',
        submit_status: 'duplicate',
        done_today: '重复提交应忽略',
      }),
    ]);

    const result = await service.run({
      businessDate: date,
      operator: 'admin',
      requestId: 'req-t5',
    });

    expect(result.missing).toEqual(['员工C']);
    expect(result.summary.source_report_ids).toEqual(['rec_员工A', 'rec_员工B']);
    expect(result.summary.source_report_ids).not.toContain('rec_员工A_dup');
  });

  it('T6 摘要结构：进展/阻塞/决策/缺交/引用标识', async () => {
    const date = '2026-10-14';
    feishu.seedDaily(date, ['员工A', '员工B', '员工C'], [
      report({
        employee: '员工A',
        date,
        done_today: '完成客户拜访',
        metrics: '签约 1',
      }),
      report({
        employee: '员工B',
        date,
        done_today: '推进交付',
        unfinished: '联调未完',
        problems: '环境不稳定',
        need_boss_decision: '是否追加测试资源',
      }),
    ]);

    const result = await service.run({
      businessDate: date,
      operator: 'admin',
      requestId: 'req-t6',
    });

    const c = result.summary.content;
    expect(c).toContain('【管理日报摘要】');
    expect(c).toContain('一、今日核心进展与关键数据');
    expect(c).toContain('三、未完成、延期与阻塞');
    expect(c).toContain('四、需管理者决策');
    expect(c).toContain('六、未提交人员');
    expect(c).toContain('七、引用日报记录标识');
    expect(c).toContain('员工C');
    expect(c).toContain('是否追加测试资源');
    expect(c).toContain('rec_员工B');
    expect(result.message_sent).toBe(true);
  });

  it('T7 手动与 cron 触发共用业务逻辑', async () => {
    const date = '2026-10-16';
    feishu.seedDaily(date, ['员工A'], [report({ employee: '员工A', date })]);

    const manual = await service.run({
      businessDate: date,
      operator: 'admin',
      trigger: 'manual',
      requestId: 'req-t7a',
    });
    expect(manual.run.trigger).toBe('manual');
    expect(manual.message_sent).toBe(true);

    // 另日用 cron 触发
    const date2 = '2026-10-17';
    feishu.seedDaily(date2, ['员工A'], [report({ employee: '员工A', date: date2 })]);
    const cronRun = await service.run({
      businessDate: date2,
      operator: 'system:cron',
      trigger: 'cron',
      requestId: 'req-t7b',
    });
    expect(cronRun.run.trigger).toBe('cron');
    expect(cronRun.message_sent).toBe(true);
    expect(cronRun.summary.content).toContain('员工A');
  });

  it('T8 同日重复执行不重复推送，修订号递增', async () => {
    const date = '2026-10-15';
    feishu.seedDaily(date, ['员工A'], [report({ employee: '员工A', date })]);

    const first = await service.run({
      businessDate: date,
      operator: 'admin',
      requestId: 'req-t8a',
    });
    const second = await service.run({
      businessDate: date,
      operator: 'admin',
      requestId: 'req-t8b',
    });

    expect(first.message_sent).toBe(true);
    expect(second.message_sent).toBe(false);
    expect(second.idempotent_skip_send).toBe(true);
    expect(second.summary.revision).toBe(2);
    expect(second.summary.message_id).toBe(first.summary.message_id);
    expect(feishu.getMessages()).toHaveLength(1);
    expect(dailySummaryIdempotentKey(date)).toBe(`daily_summary:${date}`);
  });

  it('调度器：非 20 点不触发；同业务日只触发一次', async () => {
    // 上海 20:00 = UTC 12:00
    const twenty = new Date('2026-10-14T12:00:00.000Z');
    const date = shanghaiBusinessDate(twenty);
    feishu.seedDaily(date, ['员工A'], [report({ employee: '员工A', date })]);
    const scheduler = new DailySummaryScheduler(service);

    const noonUtc = new Date('2026-10-14T04:00:00.000Z'); // 上海 12:00
    expect(isShanghaiHour(12, noonUtc)).toBe(true);
    expect(await scheduler.maybeFire(noonUtc)).toBe(false);

    expect(isShanghaiHour(20, twenty)).toBe(true);
    expect(await scheduler.maybeFire(twenty)).toBe(true);
    expect(await scheduler.maybeFire(twenty)).toBe(false);
    expect(feishu.getMessages()).toHaveLength(1);
  });
});
