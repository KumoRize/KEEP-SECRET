import { config } from '../../../config.js';
import { providerFetch } from '../http.js';
import type { ProviderAdapter } from '../types.js';
import { ProviderError } from '../types.js';

// Stable Image Core: verify current credit price at https://platform.stability.ai/pricing.
const CORE_USD = 0.03;

export const stabilityAdapter: ProviderAdapter = {
  id: 'stability',
  name: 'Stability AI',
  isConfigured: () => Boolean(config.STABILITY_API_KEY),
  models: () => [
    {
      id: 'stability:stable-image-core', providerId: 'stability', model: 'stable-image-core', modality: 'image',
      label: 'Stable Image Core', quality: 7,
      license: { commercialUse: true, note: 'Stability AI API outputs; commercial use per Stability AI Terms of Service.' },
      estimateCostUsd: () => CORE_USD,
    },
  ],
  async run(_model, req, signal) {
    const form = new FormData();
    form.append('prompt', req.prompt);
    form.append('aspect_ratio', req.params.aspectRatio ?? '1:1');
    form.append('output_format', 'png');
    const res = await providerFetch('stability', 'https://api.stability.ai/v2beta/stable-image/generate/core', {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${config.STABILITY_API_KEY}`, Accept: 'image/*' },
      body: form,
    });
    // Stability signals content-filtered output via this header.
    if (res.headers.get('finish-reason') === 'CONTENT_FILTERED') {
      throw new ProviderError('stability: output filtered by provider safety system', 'rejected');
    }
    return { files: [{ filename: 'image.png', contentType: 'image/png', data: Buffer.from(await res.arrayBuffer()) }] };
  },
};
