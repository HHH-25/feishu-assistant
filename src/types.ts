export type Confidentiality = 'public' | 'dept' | 'mgmt' | 'finance';

export type ArchiveStatus = 'pending' | 'success' | 'failed' | 'duplicate';

export interface ArchiveRecord {
  archive_id: string;
  file_name: string;
  file_id: string;
  feishu_url: string;
  content_hash: string;
  department: string;
  file_type: string;
  confidentiality: Confidentiality;
  uploader: string;
  source: string;
  uploaded_at: string;
  status: ArchiveStatus;
  owner?: string;
  version: number;
  previous_file_id?: string;
  error_message?: string;
  space_id: string;
  archive_key: string;
  updated_at: string;
}

export interface ArchiveInput {
  fileName: string;
  buffer: Buffer;
  department: string;
  fileType?: string;
  confidentiality: Confidentiality;
  spaceId: string;
  source?: string;
  operator: string;
  owner?: string;
  financeAuthorized?: boolean;
}

export interface DailyReport {
  record_id: string;
  date: string;
  employee: string;
  department: string;
  submitted_at: string;
  done_today: string;
  metrics: string;
  unfinished: string;
  problems: string;
  tomorrow_plan: string;
  need_help: string;
  need_boss_decision: string;
  submit_status: 'valid' | 'late' | 'duplicate';
  confidentiality?: Confidentiality;
}

export interface SummaryResult {
  summary_id: string;
  business_date: string;
  content: string;
  source_report_ids: string[];
  missing_employees: string[];
  revision: number;
  created_at: string;
  message_id?: string;
}

export interface JobRun {
  run_id: string;
  job_type: 'daily_summary';
  business_date: string;
  trigger: 'manual' | 'cron';
  status: 'running' | 'success' | 'failed';
  message_id?: string;
  error?: string;
  started_at: string;
  finished_at?: string;
  idempotent_key: string;
}

export interface AuditEntry {
  id: string;
  request_id: string;
  operator: string;
  action: string;
  resource: string;
  result: 'allow' | 'deny' | 'success' | 'failed';
  detail?: string;
  at: string;
}

export interface UploadResult {
  file_id: string;
  feishu_url: string;
}

export interface SendMessageResult {
  message_id: string;
}
