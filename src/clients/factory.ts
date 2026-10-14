import { config } from '../config.js';
import { logger } from '../logger.js';
import { FeishuClient, MockFeishuClient, RealFeishuClient } from './feishu.js';
import { ModelClient, MockModelClient, RealModelClient } from './model.js';

export interface AppClients {
  feishu: FeishuClient;
  model: ModelClient;
  /** mock 下可用于单测注入种子数据 */
  mockFeishu?: MockFeishuClient;
}

export function createClients(mode = config.clientMode): AppClients {
  if (mode === 'real') {
    logger.warn('CLIENT_MODE=real，但真实客户端仍为 stub，调用将失败直至实现完成');
    return {
      feishu: new RealFeishuClient(),
      model: new RealModelClient(),
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
