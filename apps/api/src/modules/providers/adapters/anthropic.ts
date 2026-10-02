import { config } from '../../../config.js';
import { codegenSystemPrompt, CODEGEN_MAX_OUTPUT_TOKENS, estimateTokens, parseCodegenFiles } from '../codegen.js';
import { providerFetch } from '../http.js';
import type { ProviderAdapter, ProviderModel } from '../types.js';
import { ProviderError } from '../types.js';

// Planning estimates in USD per token - verify against https://www.anthropic.com/pricing for ANTHROPIC_MODEL.
const IN_PER_TOKEN = 3 / 1e6;
const OUT_PER_TOKEN = 15 / 1e6;
const license = { commercialUse: true, note: 'Anthropic Commercial Terms: customer owns outputs; subject to Usage Policy.' };

const model = (modality: 'website' | 'app' | 'game'): ProviderModel => ({
  id: `anthropic:${config.ANTHROPIC_MODEL}:${modality}`,
  providerId: 'anthropic',
  model: config.ANTHROPIC_MODEL,
  modality,
  label: `Claude (${config.ANTHROPIC_MODEL})`,
  quality: 9,
  license,
  estimateCostUsd: (prompt) => (estimateTokens(prompt) + 400) * IN_PER_TOKEN + CODEGEN_MAX_OUTPUT_TOKENS * OUT_PER_TOKEN,
});

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  name: 'Anthropic',
  isConfigured: () => Boolean(config.ANTHROPIC_API_KEY),
  models: () => [model('website'), model('app'), model('game')],
  async run(m, req, signal) {
    const res = await providerFetch('anthropic', 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'x-api-key': config.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: m.model,
        max_tokens: CODEGEN_MAX_OUTPUT_TOKENS,
        system: codegenSystemPrompt(m.modality),
        messages: [{ role: 'user', content: req.prompt }],
      }),
    });
    const json = (await res.json()) as {
      content?: { type: string; text?: string }[];
      stop_reason?: string;
      usage?: { input_tokens: number; output_tokens: number };
    };
    if (json.stop_reason === 'refusal') throw new ProviderError('anthropic: request refused', 'rejected');
    if (json.stop_reason === 'max_tokens') throw new ProviderError('anthropic: output truncated', 'retriable');
    const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    const costUsd = json.usage ? json.usage.input_tokens * IN_PER_TOKEN + json.usage.output_tokens * OUT_PER_TOKEN : undefined;
    return { files: parseCodegenFiles('anthropic', text), costUsd };
  },
};
