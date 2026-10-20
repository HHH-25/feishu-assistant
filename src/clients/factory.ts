import { config } from '../config.js';
import { logger } from '../logger.js';
import { FeishuClient, MockFeishuClient } from './feishu.js';
import { RealFeishuClient } from './feishuReal.js';
import { ModelClient, MockModelClient, RealModelClient } from './model.js';
import { StateStore } from '../state.js';
import type { WikiGateway } from './wiki.js';

export interface AppClients {
  feishu: FeishuClient;
  model: ModelClient;
  /** mock 下可用于单测注入种子数据 */
  mockFeishu?: MockFeishuClient;
  state?: StateStore;
  wiki?: WikiGateway;
}

export function createClients(mode = config.clientMode): AppClients {
  if (mode === 'real') {
    const required: Record<string, string> = {
      API_ACTORS_JSON: config.apiActorsJson,
      FEISHU_APP_ID: config.feishu.appId,
      FEISHU_APP_SECRET: config.feishu.appSecret,
      FEISHU_FOLDER_MAP_JSON: config.feishu.folderMapJson,
      FEISHU_FILE_URL_TEMPLATE: config.feishu.fileUrlTemplate,
      FEISHU_BITABLE_APP_TOKEN: config.feishu.bitableAppToken,
      FEISHU_LEDGER_TABLE_ID: config.feishu.ledgerTableId,
      FEISHU_DAILY_TABLE_ID: config.feishu.dailyTableId,
      FEISHU_EXPECTED_TABLE_ID: config.feishu.expectedTableId,
      FEISHU_SUMMARY_TABLE_ID: config.feishu.summaryTableId,
      FEISHU_JOB_TABLE_ID: config.feishu.jobTableId,
      FEISHU_AUDIT_TABLE_ID: config.feishu.auditTableId,
      FEISHU_MANAGER_CHAT_ID: config.feishu.managerChatId,
    };
    if (config.modelMode === 'real') required.MODEL_API_KEY = config.model.apiKey;
    const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`真实模式缺少环境变量：${missing.join(', ')}`);
    logger.info('使用真实飞书客户端', { mode: 'real', model_mode: config.modelMode });
    const feishu = new RealFeishuClient();
    return {
      feishu,
      wiki: config.wikiEnabled ? feishu.wikiClient() : undefined,
      model: config.modelMode === 'real' ? new RealModelClient() : new MockModelClient(),
      state: new StateStore(),
    };
  }
  const mockFeishu = new MockFeishuClient();
  logger.info('使用 Mock 客户端', { mode: 'mock' });
  return {
    feishu: mockFeishu,
    model: new MockModelClient(),
    mockFeishu,
  };
}
