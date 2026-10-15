import { createClients } from './clients/factory.js';
import { config } from './config.js';
import { createApp } from './app.js';
import { logger } from './logger.js';

const clients = createClients();
const { app, scheduler } = createApp(clients);

scheduler.start();

const server = app.listen(config.port, config.host, () => {
  logger.info('服务已启动', {
    port: config.port,
    host: config.host,
    mode: config.clientMode,
    daily_cron_enabled: config.dailyCronEnabled,
    note: '凭证未齐：默认 mock；真实飞书联调暂不启用',
  });
});

const shutdown = () => {
  scheduler.stop();
  server.close(() => { clients.state?.close(); process.exit(0); });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
