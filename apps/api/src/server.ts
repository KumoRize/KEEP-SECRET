import { config } from './config.js';
import { createApp } from './app.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { logger } from './lib/logger.js';
import { flushMonitoring, initMonitoring } from './lib/monitoring.js';
import { startWorker } from './modules/generations/worker.js';

initMonitoring('api');
await migrate();
const server = createApp().listen(config.PORT, () => logger.info({ port: config.PORT }, 'api listening'));
const worker = config.RUN_WORKER_IN_API ? startWorker() : null;

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  server.close();
  await worker?.stop();
  await flushMonitoring();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
