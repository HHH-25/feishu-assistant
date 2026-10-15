import { randomUUID } from 'node:crypto';
import type { FeishuClient } from '../clients/feishu.js';
import type { ModelClient } from '../clients/model.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { JobRun, SummaryResult } from '../types.js';
import { AppError } from './archive.js';
import type { StateStore } from '../state.js';

export function dailySummaryIdempotentKey(businessDate: string): string {
  return `daily_summary:${businessDate}`;
}

/** 识别缺交：应交 − 有效提交 */
export function findMissingEmployees(expected: string[], submittedValid: string[]): string[] {
  const set = new Set(submittedValid);
  return expected.filter((e) => !set.has(e));
}

export class DailySummaryService {
  private runningDates = new Set<string>();
  constructor(
    private feishu: FeishuClient,
    private model: ModelClient,
    private state?: StateStore,
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
    const parsedDate = new Date(`${businessDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) ||
        Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== businessDate) {
      throw new AppError('VALIDATION', 'business_date 格式应为 YYYY-MM-DD', 400);
    }
    if (!operator.trim()) throw new AppError('VALIDATION', 'operator 必填', 400);
    if (this.runningDates.has(businessDate)) {
      throw new AppError('CONFLICT', '该业务日汇总正在执行', 409);
    }
    const lockOwner = this.state?.acquire(`summary:${businessDate}`);
    if (this.state && !lockOwner) throw new AppError('CONFLICT', '该业务日汇总正在其他进程执行', 409);
    this.runningDates.add(businessDate);

    const started_at = new Date().toISOString();
    const idempotent_key = dailySummaryIdempotentKey(businessDate);
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
    let sentMessageId: string | undefined;
    try {
      const existingJob = await this.feishu.getJobRunByKey(idempotent_key);
      const existingSummary = await this.feishu.getSummaryByDate(businessDate);
      const sendReceipt = this.state?.getSend(businessDate);
      if (sendReceipt && ['sending', 'uncertain'].includes(sendReceipt.state)) {
        throw new AppError('SEND_UNCERTAIN', '上次发送结果待核对，已暂停自动重发', 409);
      }
      const alreadySent = Boolean(existingJob?.message_id || existingSummary?.message_id || sendReceipt?.state === 'sent');
      await this.feishu.writeJobRun(running);
      const expected = await this.feishu.listExpectedEmployees(businessDate);
      const allReports = await this.feishu.listDailyReports(businessDate);
      const validReports = allReports
        .filter((r) => r.submit_status === 'valid' || r.submit_status === 'late')
        .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
      // 每人取一条有效：按提交时间，同人多条时仅第一条 valid，其余应已标记 duplicate
      const byEmployee = new Map<string, (typeof validReports)[0]>();
      for (const r of validReports) {
        if (!byEmployee.has(r.employee)) byEmployee.set(r.employee, r);
      }
      const uniqueValid = [...byEmployee.values()];
      // 财务机密默认不进入外部模型；缺交统计仍基于全部有效日报。
      const modelReports = uniqueValid.filter((report) => report.confidentiality !== 'finance');
      const missing = findMissingEmployees(
        expected,
        uniqueValid.map((r) => r.employee),
      );

      const { content } = await this.model.summarizeDaily({
        businessDate,
        reports: modelReports,
        missingEmployees: missing,
      });

      const revision = existingSummary ? existingSummary.revision + 1 : 1;
      const summary_id = existingSummary?.summary_id ?? randomUUID();
      let message_id = existingSummary?.message_id ?? existingJob?.message_id ?? sendReceipt?.message_id;
      let message_sent = false;
      let idempotent_skip_send = false;

      const summary: SummaryResult = {
        summary_id,
        business_date: businessDate,
        content,
        source_report_ids: modelReports.map((r) => r.record_id),
        missing_employees: missing,
        revision,
        created_at: new Date().toISOString(),
        message_id,
      };
      // 先保存摘要与来源，再通知管理者；推送失败时保留可重试的摘要。
      await this.feishu.writeSummary(summary);

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
        if (this.state && !this.state.beginSend(businessDate)) {
          throw new AppError('SEND_UNCERTAIN', '发送状态待核对，已暂停自动重发', 409);
        }
        let sent;
        try {
          sent = await this.feishu.sendMessage({ chatId, text: content });
          this.state?.markSent(businessDate, sent.message_id);
        } catch (err) {
          this.state?.markSendUncertain(businessDate);
          throw err;
        }
        message_id = sent.message_id;
        sentMessageId = message_id;
        summary.message_id = message_id;
        await this.feishu.writeJobRun({ ...running, message_id });
        await this.feishu.writeSummary(summary);
        message_sent = true;
      }

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
      const failed: JobRun = {
        ...running,
        status: 'failed',
        message_id: sentMessageId,
        error: '日报汇总执行失败；请查看受控服务日志',
        finished_at: new Date().toISOString(),
      };
      await this.feishu.writeJobRun(failed);
      // 发送结果不确定时，任何额外推送都可能制造第二条不可核对消息。
      try {
        const sendState = this.state?.getSend(businessDate)?.state;
        if (sendState !== 'sending' && sendState !== 'uncertain' &&
            !(err instanceof AppError && err.code === 'SEND_UNCERTAIN')) {
          await this.feishu.sendMessage({
            chatId: config.feishu.managerChatId || 'mock_manager_chat',
            text: `日报汇总失败 ${businessDate}；任务可重试，请联系管理员查看日志。`,
          });
        }
      } catch {
        /* 通知失败不影响主错误 */
      }
      logger.error('日报汇总失败', {
        request_id: requestId,
        operator,
        resource: idempotent_key,
        status: 'failed',
        error: err instanceof AppError ? err.code : 'UPSTREAM',
      });
      throw err;
    } finally {
      this.runningDates.delete(businessDate);
      if (lockOwner) this.state?.release(`summary:${businessDate}`, lockOwner);
    }
  }
}
