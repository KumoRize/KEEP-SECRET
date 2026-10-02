import { config } from '../../../config.js';
import type { Modality, OutputFile, ProviderAdapter, ProviderModel } from '../types.js';
import { ProviderError } from '../types.js';

/** Deterministic offline provider for local development and tests. Refused in production by config. */
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function wavTone(seconds: number): Buffer {
  const rate = 8000;
  const n = rate * Math.min(seconds, 5);
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return buf;
}

function output(modality: Modality, prompt: string, durationSec: number): OutputFile[] {
  const label = escape(prompt.slice(0, 80));
  switch (modality) {
    case 'image':
    case 'video':
      return [{ filename: `${modality}.svg`, contentType: 'image/svg+xml', data: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="100%" height="100%" fill="#4f46e5"/>` +
        `<text x="50%" y="50%" fill="#fff" font-size="20" text-anchor="middle">${label}</text></svg>`) }];
    case '3d':
      return [{ filename: 'model.gltf', contentType: 'model/gltf+json', data: Buffer.from(JSON.stringify({ asset: { version: '2.0', generator: 'mock' } })) }];
    case 'music':
      return [{ filename: 'track.wav', contentType: 'audio/wav', data: wavTone(durationSec) }];
    default:
      return [{ filename: 'index.html', contentType: 'text/html', data: Buffer.from(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>${label}</title></head>` +
        `<body><h1>${label}</h1><p>Generated ${modality} preview (mock provider).</p></body></html>`) }];
  }
}

const ALL: Modality[] = ['image', 'video', '3d', 'website', 'app', 'game', 'music'];

export const mockAdapter: ProviderAdapter = {
  id: 'mock',
  name: 'Mock (development)',
  isConfigured: () => config.ENABLE_MOCK_PROVIDER,
  models: () => ALL.map<ProviderModel>((m) => ({
    id: `mock:${m}`, providerId: 'mock', model: `mock-${m}`, modality: m, label: `Mock ${m}`, quality: 1,
    maxDurationSec: m === 'video' ? 10 : m === 'music' ? 300 : undefined,
    license: { commercialUse: true, note: 'Synthetic placeholder output.' },
    estimateCostUsd: () => 0.001,
  })),
  async run(model, req) {
    // Test hooks: prompts containing these markers simulate provider failures.
    if (req.prompt.includes('[mock:fail]')) throw new ProviderError('mock: simulated outage', 'retriable');
    if (req.prompt.includes('[mock:reject]')) throw new ProviderError('mock: content rejected', 'rejected');
    return { files: output(model.modality, req.prompt, req.params.durationSec ?? 5) };
  },
};
