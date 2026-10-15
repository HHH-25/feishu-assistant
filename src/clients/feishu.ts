import { randomUUID } from 'node:crypto';
import type {
  ArchiveRecord,
  AuditEntry,
  DailyReport,
  JobRun,
  SendMessageResult,
  SummaryResult,
  UploadResult,
} from '../types.js';

/** 飞书能力抽象：mock / real 可切换 */
export interface FeishuClient {
  uploadFile(params: {
    fileName: string;
    buffer: Buffer;
    spaceId: string;
  }): Promise<UploadResult>;

  findLedgerByHash(contentHash: string, spaceId: string): Promise<ArchiveRecord | null>;

  findLatestByName(params: {
    fileName: string;
    department: string;
    spaceId: string;
  }): Promise<ArchiveRecord | null>;

  writeLedger(record: ArchiveRecord): Promise<void>;

  getLedger(archiveId: string): Promise<ArchiveRecord | null>;

  listExpectedEmployees(businessDate: string): Promise<string[]>;

  listDailyReports(businessDate: string): Promise<DailyReport[]>;

  writeSummary(summary: SummaryResult): Promise<void>;

  getSummaryByDate(businessDate: string): Promise<SummaryResult | null>;

  writeJobRun(run: JobRun): Promise<void>;

  getJobRunByKey(idempotentKey: string): Promise<JobRun | null>;

  sendMessage(params: { chatId: string; text: string }): Promise<SendMessageResult>;

  writeAudit(entry: AuditEntry): Promise<void>;

  listAudits(): Promise<AuditEntry[]>;
}

/** 内存 Mock：可跑通归档去重/版本与日报幂等 */
export class MockFeishuClient implements FeishuClient {
  private ledgers = new Map<string, ArchiveRecord>();
  private byHash = new Map<string, string>();
  private reports: DailyReport[] = [];
  private expectedByDate = new Map<string, string[]>();
  private summaries = new Map<string, SummaryResult>();
  private jobs = new Map<string, JobRun>();
  private audits: AuditEntry[] = [];
  private messages: { message_id: string; chatId: string; text: string }[] = [];

  /** 测试辅助：种子日报与应交名单 */
  seedDaily(businessDate: string, expected: string[], reports: DailyReport[]) {
    this.expectedByDate.set(businessDate, expected);
    this.reports = this.reports.filter((r) => r.date !== businessDate).concat(reports);
  }

  getMessages() {
    return [...this.messages];
  }

  async uploadFile(params: {
    fileName: string;
    buffer: Buffer;
    spaceId: string;
  }): Promise<UploadResult> {
    const file_id = `mock_file_${randomUUID().slice(0, 8)}`;
    return {
      file_id,
      feishu_url: `https://mock.feishu.local/file/${file_id}?name=${encodeURIComponent(params.fileName)}`,
    };
  }

  async findLedgerByHash(contentHash: string, spaceId: string): Promise<ArchiveRecord | null> {
    const key = `${spaceId}:${contentHash}`;
    const id = this.byHash.get(key);
    const record = id ? this.ledgers.get(id) : null;
    return record ? { ...record } : null;
  }

  async findLatestByName(params: {
    fileName: string;
    department: string;
    spaceId: string;
  }): Promise<ArchiveRecord | null> {
    const candidates = [...this.ledgers.values()]
      .filter(
        (r) =>
          r.file_name === params.fileName &&
          r.department === params.department &&
          r.space_id === params.spaceId &&
          r.status === 'success',
      )
      .sort((a, b) => b.version - a.version);
    return candidates[0] ? { ...candidates[0] } : null;
  }

  async writeLedger(record: ArchiveRecord): Promise<void> {
    this.ledgers.set(record.archive_id, { ...record });
    this.byHash.set(`${record.space_id}:${record.content_hash}`, record.archive_id);
  }

  async getLedger(archiveId: string): Promise<ArchiveRecord | null> {
    const record = this.ledgers.get(archiveId);
    return record ? { ...record } : null;
  }

  async listExpectedEmployees(businessDate: string): Promise<string[]> {
    return this.expectedByDate.get(businessDate) ?? ['员工A', '员工B', '员工C'];
  }

  async listDailyReports(businessDate: string): Promise<DailyReport[]> {
    return this.reports.filter((r) => r.date === businessDate);
  }

  async writeSummary(summary: SummaryResult): Promise<void> {
    this.summaries.set(summary.business_date, summary);
  }

  async getSummaryByDate(businessDate: string): Promise<SummaryResult | null> {
    return this.summaries.get(businessDate) ?? null;
  }

  async writeJobRun(run: JobRun): Promise<void> {
    this.jobs.set(run.idempotent_key, run);
  }

  async getJobRunByKey(idempotentKey: string): Promise<JobRun | null> {
    return this.jobs.get(idempotentKey) ?? null;
  }

  async sendMessage(params: { chatId: string; text: string }): Promise<SendMessageResult> {
    const message_id = `mock_msg_${randomUUID().slice(0, 8)}`;
    this.messages.push({ message_id, chatId: params.chatId, text: params.text });
    return { message_id };
  }

  async writeAudit(entry: AuditEntry): Promise<void> {
    this.audits.push(entry);
  }

  async listAudits(): Promise<AuditEntry[]> {
    return [...this.audits];
  }
}
