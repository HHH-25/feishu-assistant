import { randomUUID } from 'node:crypto';
import type { FeishuClient } from '../clients/feishu.js';
import type { ModelClient } from '../clients/model.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { JobRun, SummaryResult } from '../types.js';
import { AppError } from './archive.js';

export function dailySummaryIdempotentKey(businessDate: string): string {
  return `daily_summary:${businessDate}`;
}

/** 识别缺交：应交 − 有效提交 */
export function findMissingEmployees(expected: string[], submittedValid: string[]): string[] {
  const set = new Set(submittedValid);
  return expected.filter((e) => !set.has(e));
}

export class DailySummaryService {
  constructor(
    private feishu: FeishuClient,
    private model: ModelClient,
  ) {}

  async run(params: {
    businessDate: string;
    operator: string;
    trigger?: 'manual' | 'cron';
    requestId: string;
  }): Promise<{
    run: JobRun;
    summary: SummaryResult;
    missing: string[];
    message_sent: boolean;
    idempotent_skip_send: boolean;
  }> {
    const { businessDate, operator, requestId } = params;
    const trigger = params.trigger ?? 'manual';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      throw new AppError('VALIDATION', 'business_date 格式应为 YYYY-MM-DD', 400);
    }

    const started_at = new Date().toISOString();
    const idempotent_key = dailySummaryIdempotentKey(businessDate);
    const existingJob = await this.feishu.getJobRunByKey(idempotent_key);
    const existingSummary = await this.feishu.getSummaryByDate(businessDate);
    const alreadySent = Boolean(existingJob?.message_id || existingSummary?.message_id);

    const runId = randomUUID();
    const running: JobRun = {
      run_id: runId,
      job_type: 'daily_summary',
      business_date: businessDate,
      trigger,
      status: 'running',
      started_at,
      idempotent_key,
    };
    await this.feishu.writeJobRun(running);

    try {
      const expected = await this.feishu.listExpectedEmployees(businessDate);
      const allReports = await this.feishu.listDailyReports(businessDate);
      const validReports = allReports.filter((r) => r.submit_status === 'valid' || r.submit_status === 'late');
      // 每人取一条有效：按提交时间，同人多条时仅第一条 valid，其余应已标记 duplicate
      const byEmployee = new Map<string, (typeof validReports)[0]>();
      for (const r of validReports) {
        if (!byEmployee.has(r.employee)) byEmployee.set(r.employee, r);
      }
      const uniqueValid = [...byEmployee.values()];
      const missing = findMissingEmployees(
        expected,
        uniqueValid.map((r) => r.employee),
      );

      const { content } = await this.model.summarizeDaily({
        businessDate,
        reports: uniqueValid,
        missingEmployees: missing,
      });

      const revision = existingSummary ? existingSummary.revision + 1 : 1;
      const summary_id = existingSummary?.summary_id ?? randomUUID();
      let message_id = existingSummary?.message_id ?? existingJob?.message_id;
      let message_sent = false;
      let idempotent_skip_send = false;

      if (alreadySent) {
        // 同日已推送：更新摘要为修订版，不重复发送新消息
        idempotent_skip_send = true;
        logger.info('同日汇总幂等：跳过重复推送', {
          request_id: requestId,
          business_date: businessDate,
          revision,
        });
      } else {
        const chatId = config.feishu.managerChatId || 'mock_manager_chat';
        const sent = await this.feishu.sendMessage({
          chatId,
          text: content,
        });
        message_id = sent.message_id;
        message_sent = true;
      }

      const summary: SummaryResult = {
        summary_id,
        business_date: businessDate,
        content,
        source_report_ids: uniqueValid.map((r) => r.record_id),
        missing_employees: missing,
        revision,
        created_at: new Date().toISOString(),
        message_id,
      };
      await this.feishu.writeSummary(summary);

      const done: JobRun = {
        ...running,
        status: 'success',
        message_id,
        finished_at: new Date().toISOString(),
      };
      await this.feishu.writeJobRun(done);

      await this.feishu.writeAudit({
        id: randomUUID(),
        request_id: requestId,
        operator,
        action: 'daily_summary',
        resource: idempotent_key,
        result: 'success',
        detail: `revision=${revision};missing=${missing.length};skip_send=${idempotent_skip_send}`,
        at: done.finished_at!,
      });

      logger.info('日报汇总完成', {
        request_id: requestId,
        operator,
        resource: idempotent_key,
        status: 'success',
        revision,
        message_sent,
        idempotent_skip_send,
      });

      return { run: done, summary, missing, message_sent, idempotent_skip_send };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed: JobRun = {
        ...running,
        status: 'failed',
        error: message,
        finished_at: new Date().toISOString(),
      };
      await this.feishu.writeJobRun(failed);
      // 失败通知（不吞掉原始错误）
      try {
        await this.feishu.sendMessage({
          chatId: config.feishu.managerChatId || 'mock_manager_chat',
          text: `日报汇总失败 ${businessDate}: ${message}`,
        });
      } catch {
        /* 通知失败不影响主错误 */
      }
      logger.error('日报汇总失败', {
        request_id: requestId,
        operator,
        resource: idempotent_key,
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}
