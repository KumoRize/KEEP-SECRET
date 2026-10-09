import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { claimNext, pollDelayMs, processGeneration, reapStale } from '../src/modules/generations/worker.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function starterUser() {
  const res = await request(app).post('/api/v1/auth/register').send({ email: `a${randomUUID()}@example.com`, password: 'a-strong-password' });
  const { id } = res.body.user;
  // Starter plan allows 5s video and 2 concurrent jobs.
  await pool.query(`UPDATE users SET plan_id = 'starter' WHERE id = $1`, [id]);
  return { token: res.body.accessToken as string, id: id as string };
}

async function generate(token: string, prompt: string) {
  const q = await request(app).post('/api/v1/generations/estimate').set(auth(token)).send({ prompt });
  expect(q.status).toBe(200);
  const res = await request(app).post('/api/v1/generations').set(auth(token)).set('Idempotency-Key', randomUUID())
    .send({ prompt, quoteToken: q.body.quoteToken });
  expect(res.status).toBe(202);
  return res.body.id as string;
}

const row = async (id: string) => (await pool.query('SELECT * FROM generations WHERE id = $1', [id])).rows[0];
const makeDue = (id: string) => pool.query(`UPDATE generations SET next_poll_at = now() WHERE id = $1`, [id]);
const balance = async (token: string) => (await request(app).get('/api/v1/auth/me').set(auth(token))).body.balance.total as number;

describe('long-running jobs (submit, release, poll)', () => {
  it('releases the worker while the provider renders, then completes on a later poll', async () => {
    const u = await starterUser();
    const id = await generate(u.token, 'A 5 second video of waves');

    const first = await processGeneration((await claimNext())!);
    expect(first).toMatchObject({ status: 'running', external_id: `mock-${id}`, locked_at: null, poll_count: 0 });
    expect(await claimNext()).toBeNull(); // not due yet, and nothing else queued

    await makeDue(id);
    const pending = await processGeneration((await claimNext())!);
    expect(pending).toMatchObject({ status: 'running', poll_count: 1, locked_at: null }); // provider still rendering

    await makeDue(id);
    const done = await processGeneration((await claimNext())!);
    expect(done).toMatchObject({ status: 'succeeded', provider_id: 'mock', external_id: null, charged_credits: 1 });
    const g = await request(app).get(`/api/v1/generations/${id}`).set(auth(u.token));
    expect(g.body.assets).toHaveLength(1);
    expect(await balance(u.token)).toBe(59);
  });

  it('lets other jobs run while a long job waits', async () => {
    const u = await starterUser();
    const video = await generate(u.token, 'A 5 second video of a city');
    await processGeneration((await claimNext())!); // submitted, now waiting
    const image = await generate(u.token, 'A photo of a red bicycle');
    const next = await claimNext();
    expect(next?.id).toBe(image);
    expect((await processGeneration(next!))?.status).toBe('succeeded');
    expect((await row(video)).status).toBe('running');
    await makeDue(video);
    await processGeneration((await claimNext())!);
    await makeDue(video);
    expect((await processGeneration((await claimNext())!))?.status).toBe('succeeded');
  });

  it('refunds in full when the provider fails during rendering', async () => {
    const u = await starterUser();
    const id = await generate(u.token, 'A 5 second video of rain [mock:pollfail]');
    expect(await balance(u.token)).toBe(59);
    await processGeneration((await claimNext())!);
    await makeDue(id);
    const done = await processGeneration((await claimNext())!);
    expect(done).toMatchObject({ status: 'failed', charged_credits: 0 });
    expect(done!.error).toMatch(/render failed/);
    expect(await balance(u.token)).toBe(60);
  });

  it('fails and refunds a job that passes its deadline while waiting', async () => {
    const u = await starterUser();
    const id = await generate(u.token, 'A 5 second video of snow');
    await processGeneration((await claimNext())!);
    await pool.query(`UPDATE generations SET started_at = now() - interval '2 hours', next_poll_at = now() WHERE id = $1`, [id]);
    const done = await processGeneration((await claimNext())!);
    expect(done).toMatchObject({ status: 'failed', charged_credits: 0 });
    expect(done!.error).toMatch(/timed out/);
    expect(await balance(u.token)).toBe(60);
  });

  it('reaps abandoned waiting jobs and refunds them', async () => {
    const u = await starterUser();
    const id = await generate(u.token, 'A 5 second video of fog');
    await processGeneration((await claimNext())!);
    await pool.query(`UPDATE generations SET started_at = now() - interval '3 hours', next_poll_at = now() + interval '1 hour' WHERE id = $1`, [id]);
    expect(await reapStale()).toBeGreaterThanOrEqual(1);
    expect(await row(id)).toMatchObject({ status: 'failed', charged_credits: 0 });
    expect(await balance(u.token)).toBe(60);
  });

  it('backs off between status checks up to 30 seconds', () => {
    expect(pollDelayMs(0)).toBe(5000);
    expect(pollDelayMs(1)).toBe(7500);
    expect(pollDelayMs(20)).toBe(30_000);
  });
});
