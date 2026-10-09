import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { rateLimit } from './middleware/rateLimit.js';
import { metricsHandler } from './modules/admin/metrics.js';
import { adminRoutes } from './modules/admin/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { billingRoutes, razorpayWebhook } from './modules/billing/routes.js';
import { generationRoutes } from './modules/generations/routes.js';
import { libraryRoutes } from './modules/library/routes.js';
import { localStorage, verifyFileToken } from './modules/storage/storage.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one load balancer; adjust to your topology

  // Request id for log correlation; returned to clients so support can find a failing request.
  app.use((req, res, next) => {
    const incoming = req.header('x-request-id');
    const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/healthz' || req.path === '/readyz') return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info({ requestId: id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) }, 'request');
    });
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
        frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com', config.PUBLIC_URL, 'https:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc: ["'self'", 'blob:', 'https:'],
        connectSrc: ["'self'", 'https://lumberjack.razorpay.com', 'https://api.razorpay.com'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  const origins = config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && origins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Requested-With');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') return void res.status(204).end();
      next();
    });
  }

  // Raw body for webhook signature verification must be registered before the JSON parser.
  app.use('/api/v1/webhooks/razorpay', express.raw({ type: 'application/json', limit: '1mb' }), razorpayWebhook);

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use('/api', rateLimit({ name: 'global', limit: 300, windowSec: 60, key: (req) => req.ip ?? 'unknown' }));

  app.get('/healthz', (_req, res) => void res.json({ ok: true }));
  app.get('/readyz', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  app.get('/metrics', metricsHandler);

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/billing', billingRoutes);
  app.use('/api/v1/generations', generationRoutes);
  app.use('/api/v1/library', libraryRoutes);
  app.use('/api/v1/admin', adminRoutes);
  app.use('/api', (_req, res) => void res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }));

  // Signed, expiring file URLs for the local storage driver (S3 uses presigned URLs instead).
  app.get('/files/:token', async (req, res) => {
    const t = verifyFileToken(req.params.token);
    if (!t || !localStorage) return void res.status(404).end();
    const data = await localStorage.read(t.k).catch(() => null);
    if (!data) return void res.status(404).end();
    const safeName = t.fn.replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Type', t.ct);
    res.setHeader('Content-Disposition', `${t.in ? 'inline' : 'attachment'}; filename="${safeName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Generated HTML runs in an opaque origin: scripts work, but cannot touch this app's cookies or storage.
    res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-pointer-lock; default-src 'self' 'unsafe-inline' data: blob:");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(data);
  });

  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|files|metrics).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
