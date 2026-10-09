import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { logger } from './lib/logger.js';
import { captureError, flushMonitoring, initMonitoring } from './lib/monitoring.js';
import { runBillingMaintenance } from './modules/billing/razorpay.js';
import { startWorker } from './modules/generations/worker.js';

initMonitoring('worker');
await migrate();
const worker = startWorker();
const maintenance = setInterval(() => {
  runBillingMaintenance()
    .then((r) => logger.info(r, 'billing maintenance'))
    .catch((err) => captureError(err, { where: 'billing maintenance' }));
}, 3_600_000);

const shutdown = async () => {
  clearInterval(maintenance);
  await worker.stop();
  await flushMonitoring();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
