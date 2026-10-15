import dotenv from 'dotenv';

dotenv.config();

export type ClientMode = 'mock' | 'real';

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

export const config = {
  clientMode: (env('CLIENT_MODE', 'mock') as ClientMode) === 'real' ? 'real' as const : 'mock' as const,
  port: Number(env('PORT', '3000')) || 3000,
  host: env('HOST', '127.0.0.1'),
  logLevel: env('LOG_LEVEL', 'info'),
  apiActorsJson: env('API_ACTORS_JSON'),
  feishu: {
    baseUrl: env('FEISHU_BASE_URL', 'https://open.feishu.cn/open-apis'),
    appId: env('FEISHU_APP_ID'),
    appSecret: env('FEISHU_APP_SECRET'),
    folderMapJson: env('FEISHU_FOLDER_MAP_JSON'),
    fileUrlTemplate: env('FEISHU_FILE_URL_TEMPLATE'),
    bitableAppToken: env('FEISHU_BITABLE_APP_TOKEN'),
    ledgerTableId: env('FEISHU_LEDGER_TABLE_ID'),
    dailyTableId: env('FEISHU_DAILY_TABLE_ID'),
    expectedTableId: env('FEISHU_EXPECTED_TABLE_ID'),
    summaryTableId: env('FEISHU_SUMMARY_TABLE_ID'),
    jobTableId: env('FEISHU_JOB_TABLE_ID'),
    auditTableId: env('FEISHU_AUDIT_TABLE_ID'),
    managerChatId: env('FEISHU_MANAGER_CHAT_ID'),
    financeSpaceId: env('FEISHU_FINANCE_SPACE_ID', 'space_finance_test'),
  },
  model: {
    apiKey: env('MODEL_API_KEY'),
    baseUrl: env('MODEL_BASE_URL', 'https://api.openai.com/v1'),
    modelName: env('MODEL_NAME', 'gpt-4o-mini'),
  },
  stateDbPath: env('STATE_DB_PATH', './data/state.db'),
  dailyCronEnabled: envBool('DAILY_CRON_ENABLED', false),
  timezone: env('TZ', 'Asia/Shanghai'),
} as const;

/** 允许的文件扩展名（R2） */
export const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.txt']);

/** 单文件大小上限 20MB */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
