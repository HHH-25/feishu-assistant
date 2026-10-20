import { randomUUID } from 'node:crypto';
import type { ApiActor } from '../auth.js';
import { authorizeEmployee } from '../auth.js';
import type { FeishuClient } from '../clients/feishu.js';
import type { StateStore } from '../state.js';
import type { DailyReport, DailyReportInput } from '../types.js';
import { AppError } from './archive.js';

export interface DailyDraft {
  done_today: string;
  metrics?: string;
  unfinished?: string;
  problems?: string;
  tomorrow_plan?: string;
  need_help?: string;
  need_boss_decision?: string;
}

const REPORT_FIELDS = [
  'done_today', 'metrics', 'unfinished', 'problems', 'tomorrow_plan',
  'need_help', 'need_boss_decision',
] as const;

function shanghaiDay(now: Date): { date: string; hour: number } {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
}

function submissionKey(actor: ApiActor, date: string): string {
  return `employee:${date}:${actor.operator}`;
}

export class EmployeeDailyService {
  constructor(private feishu: FeishuClient, private state?: StateStore,
    private now: () => Date = () => new Date()) {}

  async get(actor: ApiActor, date = shanghaiDay(this.now()).date): Promise<DailyReport | null> {
    authorizeEmployee(actor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw new AppError('VALIDATION', '日期格式应为 YYYY-MM-DD', 400);
    }
    const key = submissionKey(actor, date);
    return (await this.feishu.listDailyReports(date)).find((report) => report.test_case_id === key) ?? null;
  }

  async submit(actor: ApiActor, draft: DailyDraft, requestId: string): Promise<{ report: DailyReport; updated: boolean }> {
    authorizeEmployee(actor);
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new AppError('VALIDATION', '日报内容无效', 400);
    }
    const fields = {} as Record<(typeof REPORT_FIELDS)[number], string>;
    for (const name of REPORT_FIELDS) {
      const value: unknown = draft[name];
      if (value !== undefined && typeof value !== 'string') {
        throw new AppError('VALIDATION', `${name} 必须是文字`, 400);
      }
      const cleaned = (value ?? '').trim() as string;
      if (cleaned.length > 2000) throw new AppError('VALIDATION', `${name} 超过 2000 字`, 400);
      fields[name] = cleaned;
    }
    if (!fields.done_today) throw new AppError('VALIDATION', 'done_today 必填；无完成事项可填“无”', 400);

    const now = this.now();
    const { date, hour } = shanghaiDay(now);
    const key = submissionKey(actor, date);
    const lockOwner = this.state?.acquire(`daily:${key}`);
    if (this.state && !lockOwner) throw new AppError('CONFLICT', '这份日报正在提交，请稍后查询', 409);
    try {
      const existing = await this.get(actor, date);
      const input: DailyReportInput = {
        test_case_id: key, date, employee: actor.employee, department: actor.department,
        submitted_at: existing?.submitted_at ?? now.toISOString(),
        submit_status: existing?.submit_status ?? (hour >= 20 ? 'late' : 'valid'),
        confidentiality: actor.default_confidentiality,
        ...fields,
      };
      const report = await this.feishu.upsertDailyReport(input);
      await this.feishu.writeAudit({
        id: randomUUID(), request_id: requestId, operator: actor.operator,
        action: existing ? 'daily_report_update' : 'daily_report_submit',
        resource: report.record_id, result: 'success',
        detail: `business_date=${date}`, at: now.toISOString(),
      });
      return { report, updated: Boolean(existing) };
    } finally {
      if (lockOwner) this.state?.release(`daily:${key}`, lockOwner);
    }
  }
}
