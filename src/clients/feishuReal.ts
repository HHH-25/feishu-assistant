import { createHash } from 'node:crypto';
import { config } from '../config.js';
import type {
  ArchiveRecord, AuditEntry, DailyReport, DailyReportInput, JobRun, SendMessageResult,
  SummaryResult, UploadResult,
} from '../types.js';
import type { FeishuClient } from './feishu.js';

type Settings = typeof config.feishu;
type Fields = Record<string, unknown>;
interface BitableRow { record_id: string; fields: Fields }
interface Envelope { code: number; msg?: string; data?: Record<string, unknown> }

function required(value: string, name: string): string {
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'text' in value) return text(value.text);
  return '';
}

function jsonArray(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(text(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function uuidFor(key: string): string {
  const bytes = createHash('sha256').update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 飞书开放接口适配；表字段统一使用文本列，表结构见部署说明。 */
export class RealFeishuClient implements FeishuClient {
  private token: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;
  private folderMap: Record<string, string>;

  constructor(private settings: Settings = config.feishu, private fetcher: typeof fetch = fetch) {
    const parsed: unknown = settings.folderMapJson ? JSON.parse(settings.folderMapJson) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== 'string' || !value)) {
      throw new Error('FEISHU_FOLDER_MAP_JSON 必须是 space_id 到 folder_token 的映射');
    }
    this.folderMap = parsed as Record<string, string>;
  }

  private base(): string { return this.settings.baseUrl.replace(/\/$/, ''); }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = (async () => {
      const response = await this.fetcher(`${this.base()}/auth/v3/tenant_access_token/internal`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: required(this.settings.appId, 'FEISHU_APP_ID'),
          app_secret: required(this.settings.appSecret, 'FEISHU_APP_SECRET') }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`飞书鉴权 HTTP ${response.status}`);
      const data = await response.json() as Envelope & { tenant_access_token?: string; expire?: number };
      if (data.code !== 0 || !data.tenant_access_token) throw new Error(`飞书鉴权失败 code=${data.code}`);
      this.token = { value: data.tenant_access_token,
        expiresAt: Date.now() + Math.max(0, (data.expire ?? 7200) - 120) * 1000 };
      return this.token.value;
    })();
    try { return await this.tokenRequest; } finally { this.tokenRequest = null; }
  }

  private async api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = await this.accessToken();
    const response = await this.fetcher(`${this.base()}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const envelope = await response.json().catch(() => ({ code: undefined })) as Envelope;
    if (!response.ok) throw new Error(`飞书 API HTTP ${response.status} code=${envelope.code ?? 'unknown'}`);
    if (envelope.code !== 0) throw new Error(`飞书 API code=${envelope.code}`);
    return envelope.data ?? {};
  }

  private tablePath(tableId: string): string {
    const app = encodeURIComponent(required(this.settings.bitableAppToken, 'FEISHU_BITABLE_APP_TOKEN'));
    return `/bitable/v1/apps/${app}/tables/${encodeURIComponent(required(tableId, '飞书 table_id'))}/records`;
  }

  private async rows(tableId: string): Promise<BitableRow[]> {
    const rows: BitableRow[] = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.api('GET', `${this.tablePath(tableId)}?${query}`);
      const items = data.items;
      if (!Array.isArray(items)) throw new Error('飞书多维表返回 items 无效');
      rows.push(...items as BitableRow[]);
      pageToken = data.has_more ? text(data.page_token) : '';
      if (data.has_more && !pageToken) throw new Error('飞书多维表分页令牌缺失');
    } while (pageToken);
    return rows;
  }

  private async upsert(tableId: string, key: string, value: string, fields: Fields): Promise<string> {
    const row = (await this.rows(tableId)).find((item) => text(item.fields[key]) === value);
    if (row) {
      await this.api('PUT', `${this.tablePath(tableId)}/${encodeURIComponent(row.record_id)}`, { fields });
      return row.record_id;
    } else {
      const query = new URLSearchParams({ client_token: uuidFor(`${tableId}:${key}:${value}`) });
      const data = await this.api('POST', `${this.tablePath(tableId)}?${query}`, { fields });
      const created = data.record as BitableRow | undefined;
      if (!created?.record_id) throw new Error('飞书多维表创建记录未返回 record_id');
      return created.record_id;
    }
  }

  /** 只供隔离测试租户的种子脚本调用；业务接口不暴露任意写表能力。 */
  async upsertTestRecord(kind: 'expected' | 'daily', testCaseId: string, fields: Fields): Promise<string> {
    if (!/^seed:[0-9]{4}-[0-9]{2}-[0-9]{2}:[A-Za-z0-9_-]+$/.test(testCaseId)) {
      throw new Error('test_case_id 格式无效');
    }
    const tableId = kind === 'expected' ? this.settings.expectedTableId : this.settings.dailyTableId;
    return this.upsert(tableId, 'test_case_id', testCaseId, { ...fields, test_case_id: testCaseId });
  }

  async uploadFile(params: { fileName: string; buffer: Buffer; spaceId: string }): Promise<UploadResult> {
    const folder = this.folderMap[params.spaceId];
    if (!folder) throw new Error(`目标空间 ${params.spaceId} 未配置文件夹`);
    const template = required(this.settings.fileUrlTemplate, 'FEISHU_FILE_URL_TEMPLATE');
    if (!template.includes('{file_id}')) throw new Error('FEISHU_FILE_URL_TEMPLATE 需包含 {file_id}');
    const form = new FormData();
    form.set('file_name', params.fileName);
    form.set('parent_type', 'explorer');
    form.set('parent_node', folder);
    form.set('size', String(params.buffer.length));
    form.set('file', new Blob([Uint8Array.from(params.buffer)]), params.fileName);
    const response = await this.fetcher(`${this.base()}/drive/v1/files/upload_all`, {
      method: 'POST', headers: { authorization: `Bearer ${await this.accessToken()}` },
      body: form, signal: AbortSignal.timeout(60_000),
    });
    const envelope = await response.json().catch(() => ({ code: undefined })) as Envelope;
    if (!response.ok) throw new Error(`飞书上传 HTTP ${response.status} code=${envelope.code ?? 'unknown'}`);
    if (envelope.code !== 0) throw new Error(`飞书上传失败 code=${envelope.code}`);
    const fileId = text(envelope.data?.file_token);
    if (!fileId) throw new Error('飞书上传未返回 file_token');
    return { file_id: fileId, feishu_url: template.replace('{file_id}', encodeURIComponent(fileId)) };
  }

  private archive(row: BitableRow): ArchiveRecord {
    const f = row.fields;
    return {
      archive_id: text(f.archive_id), file_name: text(f.file_name), file_id: text(f.file_id),
      feishu_url: text(f.feishu_url), content_hash: text(f.content_hash),
      department: text(f.department), file_type: text(f.file_type),
      confidentiality: text(f.confidentiality) as ArchiveRecord['confidentiality'],
      uploader: text(f.uploader), source: text(f.source), uploaded_at: text(f.uploaded_at),
      status: text(f.status) as ArchiveRecord['status'], owner: text(f.owner),
      version: Number(text(f.version)) || 1, previous_file_id: text(f.previous_file_id) || undefined,
      error_message: text(f.error_message) || undefined, space_id: text(f.space_id),
      archive_key: text(f.archive_key), updated_at: text(f.updated_at),
    };
  }

  async findLedgerByHash(contentHash: string, spaceId: string): Promise<ArchiveRecord | null> {
    const row = (await this.rows(this.settings.ledgerTableId)).find((item) =>
      text(item.fields.content_hash) === contentHash && text(item.fields.space_id) === spaceId);
    return row ? this.archive(row) : null;
  }
  async findLatestByName(params: { fileName: string; department: string; spaceId: string }): Promise<ArchiveRecord | null> {
    const records = (await this.rows(this.settings.ledgerTableId)).map((row) => this.archive(row))
      .filter((item) => item.file_name === params.fileName && item.department === params.department &&
        item.space_id === params.spaceId && item.status === 'success')
      .sort((a, b) => b.version - a.version);
    return records[0] ?? null;
  }
  async writeLedger(record: ArchiveRecord): Promise<void> {
    const fields: Fields = {};
    for (const [key, value] of Object.entries(record)) fields[key] = value === undefined ? '' : String(value);
    await this.upsert(this.settings.ledgerTableId, 'archive_id', record.archive_id, fields);
  }
  async getLedger(archiveId: string): Promise<ArchiveRecord | null> {
    const row = (await this.rows(this.settings.ledgerTableId)).find((item) => text(item.fields.archive_id) === archiveId);
    return row ? this.archive(row) : null;
  }
  async listLedgers(): Promise<ArchiveRecord[]> {
    return (await this.rows(this.settings.ledgerTableId)).map((row) => this.archive(row));
  }
  async listExpectedEmployees(businessDate: string): Promise<string[]> {
    const rows = await this.rows(this.settings.expectedTableId);
    return rows.filter((row) => ['*', businessDate].includes(text(row.fields.business_date)) &&
        text(row.fields.active).toLowerCase() !== 'false')
      .map((row) => text(row.fields.employee)).filter(Boolean);
  }
  async listDailyReports(businessDate: string): Promise<DailyReport[]> {
    return (await this.rows(this.settings.dailyTableId))
      .filter((row) => text(row.fields.date) === businessDate)
      .map((row) => {
        const f = row.fields;
        return {
          record_id: row.record_id, test_case_id: text(f.test_case_id), date: text(f.date), employee: text(f.employee),
          department: text(f.department), submitted_at: text(f.submitted_at),
          done_today: text(f.done_today), metrics: text(f.metrics), unfinished: text(f.unfinished),
          problems: text(f.problems), tomorrow_plan: text(f.tomorrow_plan), need_help: text(f.need_help),
          need_boss_decision: text(f.need_boss_decision),
          submit_status: text(f.submit_status) as DailyReport['submit_status'],
          confidentiality: text(f.confidentiality) as DailyReport['confidentiality'],
        };
      });
  }
  async upsertDailyReport(report: DailyReportInput): Promise<DailyReport> {
    const fields: Fields = {};
    for (const [key, value] of Object.entries(report)) fields[key] = value === undefined ? '' : String(value);
    const record_id = await this.upsert(this.settings.dailyTableId, 'test_case_id', report.test_case_id, fields);
    return { ...report, record_id };
  }
  async writeSummary(summary: SummaryResult): Promise<void> {
    await this.upsert(this.settings.summaryTableId, 'business_date', summary.business_date, {
      summary_id: summary.summary_id, business_date: summary.business_date, content: summary.content,
      source_report_ids: JSON.stringify(summary.source_report_ids),
      missing_employees: JSON.stringify(summary.missing_employees), revision: String(summary.revision),
      created_at: summary.created_at, message_id: summary.message_id ?? '',
    });
  }
  async getSummaryByDate(businessDate: string): Promise<SummaryResult | null> {
    const row = (await this.rows(this.settings.summaryTableId)).find((item) =>
      text(item.fields.business_date) === businessDate);
    if (!row) return null;
    const f = row.fields;
    return { summary_id: text(f.summary_id), business_date: businessDate, content: text(f.content),
      source_report_ids: jsonArray(f.source_report_ids), missing_employees: jsonArray(f.missing_employees),
      revision: Number(text(f.revision)) || 1, created_at: text(f.created_at),
      message_id: text(f.message_id) || undefined };
  }
  async writeJobRun(run: JobRun): Promise<void> {
    const fields: Fields = {};
    for (const [key, value] of Object.entries(run)) fields[key] = value === undefined ? '' : String(value);
    await this.upsert(this.settings.jobTableId, 'idempotent_key', run.idempotent_key, fields);
  }
  async getJobRunByKey(key: string): Promise<JobRun | null> {
    const row = (await this.rows(this.settings.jobTableId)).find((item) => text(item.fields.idempotent_key) === key);
    if (!row) return null;
    const f = row.fields;
    return { run_id: text(f.run_id), job_type: 'daily_summary', business_date: text(f.business_date),
      trigger: text(f.trigger) as JobRun['trigger'], status: text(f.status) as JobRun['status'],
      message_id: text(f.message_id) || undefined, error: text(f.error) || undefined,
      started_at: text(f.started_at), finished_at: text(f.finished_at) || undefined, idempotent_key: key };
  }
  async sendMessage(params: { chatId: string; text: string }): Promise<SendMessageResult> {
    const data = await this.api('POST', '/im/v1/messages?receive_id_type=chat_id', {
      receive_id: params.chatId, msg_type: 'text', content: JSON.stringify({ text: params.text }),
    });
    const messageId = text(data.message_id);
    if (!messageId) throw new Error('飞书消息未返回 message_id');
    return { message_id: messageId };
  }
  async writeAudit(entry: AuditEntry): Promise<void> {
    const fields: Fields = {};
    for (const [key, value] of Object.entries(entry)) fields[key] = value === undefined ? '' : String(value);
    await this.upsert(this.settings.auditTableId, 'id', entry.id, fields);
  }
  async listAudits(): Promise<AuditEntry[]> {
    return (await this.rows(this.settings.auditTableId)).map((row) => {
      const f = row.fields;
      return { id: text(f.id), request_id: text(f.request_id), operator: text(f.operator),
        action: text(f.action), resource: text(f.resource), result: text(f.result) as AuditEntry['result'],
        detail: text(f.detail) || undefined, at: text(f.at) };
    });
  }
}
