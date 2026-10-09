import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { loadCatalog, seedDefaultCatalog } from '../src/modules/catalog/catalog.js';
import { catalogToModel, falAdapter } from '../src/modules/providers/adapters/fal.js';
import { ProviderError } from '../src/modules/providers/types.js';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  config.FAL_KEY = undefined;
});

async function veo() {
  await seedDefaultCatalog();
  const row = (await loadCatalog(true)).find((r) => r.id === 'fal:fal-ai/veo3.1/fast')!;
  return catalogToModel(row, 'video');
}

describe('fal adapter', () => {
  const req = { generationId: 'g1', prompt: 'monsoon clouds', modality: 'video' as const, params: { durationSec: 5, aspectRatio: '16:9' as const } };

  it('submits with the model input, then polls the returned URLs until the media is downloaded', async () => {
    config.FAL_KEY = 'fal-test';
    const model = await veo();
    const calls: { url: string; init?: RequestInit }[] = [];
    let statusCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://queue.fal.run/fal-ai/veo3.1/fast') {
        return json({ request_id: 'r1', status_url: 'https://queue.fal.run/fal-ai/veo3.1/requests/r1/status', response_url: 'https://queue.fal.run/fal-ai/veo3.1/requests/r1' });
      }
      if (url.endsWith('/status')) return json({ status: ++statusCalls === 1 ? 'IN_PROGRESS' : 'COMPLETED' });
      if (url.endsWith('/requests/r1')) return json({ video: { url: 'https://cdn.fal.media/out.mp4' } });
      if (url === 'https://cdn.fal.media/out.mp4') return new Response(Buffer.from('MP4DATA'), { headers: { 'content-type': 'video/mp4' } });
      throw new Error(`unexpected ${url}`);
    }));
    const { externalId } = await falAdapter.submit!(model, req, AbortSignal.timeout(5000));
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toEqual({ prompt: 'monsoon clouds', duration: '4s', aspect_ratio: '16:9' }); // 5s snapped to Veo's 4/6/8
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Key fal-test');
    expect(model.estimateCostUsd('', { durationSec: 5 })).toBeCloseTo(0.15 * 4);

    expect(await falAdapter.poll!(model, externalId, req, AbortSignal.timeout(5000))).toEqual({ status: 'pending' });
    const done = await falAdapter.poll!(model, externalId, req, AbortSignal.timeout(5000));
    expect(done.status).toBe('done');
    if (done.status === 'done') expect(done.result.files[0]).toMatchObject({ filename: 'output.mp4', contentType: 'video/mp4' });
    // Status/result URLs from the submit response are used verbatim.
    expect(calls.map((c) => c.url)).toContain('https://queue.fal.run/fal-ai/veo3.1/requests/r1/status');
  });

  it('treats safety-checker blocks as final refusals', async () => {
    config.FAL_KEY = 'fal-test';
    const model = await veo();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/status')
      ? json({ status: 'COMPLETED' })
      : json({ images: [{ url: 'https://cdn.fal.media/x.png' }], has_nsfw_concepts: [true] }))));
    const ext = JSON.stringify({ s: 'https://queue.fal.run/x/requests/1/status', r: 'https://queue.fal.run/x/requests/1' });
    const err = await falAdapter.poll!(model, ext, req, AbortSignal.timeout(5000)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('rejected');
  });

  it('rejects submit responses with non-https queue URLs', async () => {
    config.FAL_KEY = 'fal-test';
    const model = await veo();
    vi.stubGlobal('fetch', vi.fn(async () => json({ request_id: 'r', status_url: 'http://evil/status', response_url: 'http://evil/r' })));
    await expect(falAdapter.submit!(model, req, AbortSignal.timeout(5000))).rejects.toThrow(/bad queue URLs/);
  });

  it('only lists enabled catalog rows', async () => {
    await seedDefaultCatalog();
    await pool.query(`UPDATE catalog_models SET enabled = false WHERE id = 'fal:fal-ai/veo3.1'`);
    await loadCatalog(true);
    expect(falAdapter.models().map((m) => m.id)).not.toContain('fal:fal-ai/veo3.1');
    expect(falAdapter.models().map((m) => m.id)).toContain('fal:fal-ai/veo3.1/fast');
  });
});
