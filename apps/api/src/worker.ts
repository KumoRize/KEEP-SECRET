import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { logger } from './lib/logger.js';
import { runBillingMaintenance } from './modules/billing/razorpay.js';
import { startWorker } from './modules/generations/worker.js';

await migrate();
const worker = startWorker();
const maintenance = setInterval(() => {
  runBillingMaintenance()
    .then((r) => logger.info(r, 'billing maintenance'))
    .catch((err) => logger.error({ err }, 'billing maintenance failed'));
}, 3_600_000);

const shutdown = async () => {
  clearInterval(maintenance);
  await worker.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
