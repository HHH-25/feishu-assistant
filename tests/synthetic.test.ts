import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MockFeishuClient } from '../src/clients/feishu.js';
import { MockModelClient } from '../src/clients/model.js';
import { syntheticDailyRows } from '../src/demo/syntheticDaily.js';
import { DailySummaryService } from '../src/services/dailySummary.js';
import type { DailyReport } from '../src/types.js';

describe('隔离测试租户的虚构种子', () => {
  it('A/B/D 有效，C 缺交，重复提交与财务日报不进入模型', async () => {
    const date = '2026-10-15';
    const rows = syntheticDailyRows(date);
    expect(new Set(rows.map((row) => row.testCaseId)).size).toBe(rows.length);
    const expected = rows.filter((row) => row.kind === 'expected').map((row) => row.fields.employee);
    const reports = rows.filter((row) => row.kind === 'daily').map((row): DailyReport => ({
      ...row.fields,
      record_id: row.testCaseId,
      date,
      employee: row.fields.employee,
      department: row.fields.department,
      submitted_at: row.fields.submitted_at,
      done_today: row.fields.done_today,
      metrics: row.fields.metrics,
      unfinished: row.fields.unfinished,
      problems: row.fields.problems,
      tomorrow_plan: row.fields.tomorrow_plan,
      need_help: row.fields.need_help,
      need_boss_decision: row.fields.need_boss_decision,
      submit_status: row.fields.submit_status as DailyReport['submit_status'],
      confidentiality: row.fields.confidentiality as DailyReport['confidentiality'],
    }));
    const feishu = new MockFeishuClient();
    feishu.seedDaily(date, expected, reports);
    const model = new MockModelClient();
    const summarize = vi.spyOn(model, 'summarizeDaily');
    const result = await new DailySummaryService(feishu, model).run({
      businessDate: date, operator: 'admin', requestId: 'synthetic',
    });
    expect(result.missing).toEqual(['员工C']);
    expect(result.summary.source_report_ids).toEqual([
      `seed:${date}:report_A`, `seed:${date}:report_B`,
    ]);
    expect(summarize.mock.calls[0][0].reports.map((report) => report.employee)).toEqual(['员工A', '员工B']);
  });

  it('真实飞书可搭配模拟模型，且不要求 MODEL_API_KEY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feishu-hybrid-'));
    try {
      const settings = {
        CLIENT_MODE: 'real', MODEL_MODE: 'mock', MODEL_API_KEY: '',
        API_ACTORS_JSON: JSON.stringify([{ key: 'synthetic-test-key-123456789',
          operator: 'user:test', spaces: ['space_sales'], can_run_summary: true, finance: false }]),
        FEISHU_APP_ID: 'test-app', FEISHU_APP_SECRET: 'test-secret',
        FEISHU_FOLDER_MAP_JSON: '{"space_sales":"folder-test"}',
        FEISHU_FILE_URL_TEMPLATE: 'https://tenant.example/file/{file_id}',
        FEISHU_BITABLE_APP_TOKEN: 'base-test', FEISHU_LEDGER_TABLE_ID: 'ledger',
        FEISHU_DAILY_TABLE_ID: 'daily', FEISHU_EXPECTED_TABLE_ID: 'expected',
        FEISHU_SUMMARY_TABLE_ID: 'summary', FEISHU_JOB_TABLE_ID: 'job',
        FEISHU_AUDIT_TABLE_ID: 'audit', FEISHU_MANAGER_CHAT_ID: 'chat-test',
        STATE_DB_PATH: join(dir, 'state.db'),
      };
      for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
      vi.resetModules();
      const { createClients } = await import('../src/clients/factory.js');
      const clients = createClients();
      expect(clients.feishu.constructor.name).toBe('RealFeishuClient');
      expect(clients.model.constructor.name).toBe('MockModelClient');
      clients.state?.close();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
