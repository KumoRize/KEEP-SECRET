import { config } from '../../../config.js';
import { providerFetch } from '../http.js';
import type { ProviderAdapter } from '../types.js';

// Eleven Music API. Endpoint, parameters and per-minute price should be re-checked against
// https://elevenlabs.io/docs/api-reference before launch; the estimate is deliberately conservative.
const USD_PER_SEC = 0.01;

export const elevenlabsAdapter: ProviderAdapter = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  isConfigured: () => Boolean(config.ELEVENLABS_API_KEY),
  models: () => [
    {
      id: 'elevenlabs:music_v1', providerId: 'elevenlabs', model: 'music_v1', modality: 'music',
      label: 'Eleven Music', quality: 8, maxDurationSec: 300,
      license: { commercialUse: true, note: 'Eleven Music: commercial use per ElevenLabs terms for the account plan in use.' },
      estimateCostUsd: (_p, params) => USD_PER_SEC * (params.durationSec ?? 30),
    },
  ],
  async run(model, req, signal) {
    const durationSec = Math.min(Math.max(req.params.durationSec ?? 30, 10), 300);
    const res = await providerFetch('elevenlabs', 'https://api.elevenlabs.io/v1/music', {
      method: 'POST',
      signal,
      headers: { 'xi-api-key': config.ELEVENLABS_API_KEY!, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ prompt: req.prompt, music_length_ms: durationSec * 1000, model_id: model.model }),
    });
    return { files: [{ filename: 'track.mp3', contentType: 'audio/mpeg', data: Buffer.from(await res.arrayBuffer()) }] };
  },
};
