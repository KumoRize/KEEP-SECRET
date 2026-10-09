import { pool } from './db/pool.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { seedDefaultCatalog, syncOpenRouter } from './modules/catalog/catalog.js';
import { runAutomations } from './modules/automation/automation.js';
import { loadSecrets } from './modules/settings/secrets.js';
import { loadSettings, watchSettings } from './modules/settings/settings.js';
import { logger } from './lib/logger.js';
import { captureError, flushMonitoring, initMonitoring } from './lib/monitoring.js';
import { runBillingMaintenance } from './modules/billing/razorpay.js';
import { startWorker } from './modules/generations/worker.js';

initMonitoring('worker');
await migrate();
await seedDefaultCatalog();
await loadSettings();
await loadSecrets();
const stopWatching = watchSettings(async () => { await loadSettings(); await loadSecrets(); });
// Owner automations (daily report, loss guard): checked every 10 minutes, each runs once per day.
const automationTimer = setInterval(() => {
  runAutomations().catch((err) => captureError(err, { where: 'automations' }));
}, 10 * 60_000);
const syncCatalog = () => {
  if (!config.OPENROUTER_API_KEY) return;
  syncOpenRouter().catch((err) => captureError(err, { where: 'openrouter sync' }));
};
syncCatalog();
const catalogTimer = setInterval(syncCatalog, 24 * 3_600_000);
const worker = startWorker();
const maintenance = setInterval(() => {
  runBillingMaintenance()
    .then((r) => logger.info(r, 'billing maintenance'))
    .catch((err) => captureError(err, { where: 'billing maintenance' }));
}, 3_600_000);

const shutdown = async () => {
  clearInterval(maintenance);
  clearInterval(catalogTimer);
  clearInterval(automationTimer);
  await stopWatching();
  await worker.stop();
  await flushMonitoring();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
