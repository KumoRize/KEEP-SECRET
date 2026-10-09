import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { alert, resetAlertThrottle } from '../src/lib/monitoring.js';
import { checkBacklog } from '../src/modules/generations/worker.js';
import { CircuitBreaker } from '../src/modules/providers/circuitBreaker.js';

const app = createApp();
const received: { text: string }[] = [];
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as { port: number };
  config.ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;
  config.METRICS_TOKEN = 'metrics-token-0123456789';
});

afterAll(async () => {
  config.ALERT_WEBHOOK_URL = undefined;
  config.METRICS_TOKEN = undefined;
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  received.length = 0;
  resetAlertThrottle();
});

describe('alerts', () => {
  it('posts to the webhook and throttles repeats of the same alert for 15 minutes', async () => {
    const t0 = 1_000_000;
    expect(await alert('k', 'first', t0)).toBe(true);
    expect(await alert('k', 'again', t0 + 60_000)).toBe(false);
    expect(await alert('other', 'different key', t0 + 60_000)).toBe(true);
    expect(await alert('k', 'after cooldown', t0 + 16 * 60_000)).toBe(true);
    expect(received.map((r) => r.text)).toEqual(['[test] first', '[test] different key', '[test] after cooldown']);
  });

  it('fires once when a provider circuit opens, not on every later failure', () => {
    const opened: string[] = [];
    const b = new CircuitBreaker(3, 60_000, () => 0, (id) => opened.push(id));
    for (let i = 0; i < 6; i++) b.recordFailure('replicate');
    expect(opened).toEqual(['replicate']);
  });

  it('alerts when queued jobs wait too long', async () => {
    const { rows: [u] } = await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`m${randomUUID()}@example.com`]);
    await pool.query(
      `INSERT INTO generations (user_id, prompt, modality, held_credits, idempotency_key, created_at) VALUES ($1, 'p', 'image', 1, 'k', now() - interval '10 minutes')`,
      [u!.id],
    );
    const r = await checkBacklog(300);
    expect(r.oldestSec).toBeGreaterThanOrEqual(600);
    expect(received.at(-1)?.text).toMatch(/queued; the oldest has waited 10 min/);
    await pool.query(`DELETE FROM generations WHERE user_id = $1`, [u!.id]);
  });
});

describe('metrics and request ids', () => {
  it('hides /metrics without the token and serves Prometheus text with it', async () => {
    expect((await request(app).get('/metrics')).status).toBe(404);
    expect((await request(app).get('/metrics').set('Authorization', 'Bearer wrong-token-0123456789')).status).toBe(404);
    const res = await request(app).get('/metrics').set('Authorization', 'Bearer metrics-token-0123456789');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^creator_generations_queued \d+$/m);
    expect(res.text).toMatch(/^creator_generations_waiting \d+$/m);
    expect(res.text).toMatch(/^creator_queue_oldest_seconds \d+$/m);
  });

  it('returns a request id, echoing a valid incoming one', async () => {
    const res = await request(app).get('/healthz');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await request(app).get('/healthz').set('X-Request-Id', 'trace-abc-12345');
    expect(echoed.headers['x-request-id']).toBe('trace-abc-12345');
    const unsafe = await request(app).get('/healthz').set('X-Request-Id', 'bad id with spaces!');
    expect(unsafe.headers['x-request-id']).not.toBe('bad id with spaces!');
  });
});
