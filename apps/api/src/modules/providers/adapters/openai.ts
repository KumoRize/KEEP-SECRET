import { config } from '../../../config.js';
import { codegenSystemPrompt, CODEGEN_MAX_OUTPUT_TOKENS, estimateTokens, parseCodegenFiles } from '../codegen.js';
import { providerFetch } from '../http.js';
import type { ProviderAdapter, ProviderModel } from '../types.js';
import { ProviderError } from '../types.js';

const BASE = 'https://api.openai.com/v1';
const headers = () => ({ Authorization: `Bearer ${config.OPENAI_API_KEY}`, 'Content-Type': 'application/json' });

// Prices are planning estimates in USD - verify against https://openai.com/api/pricing before launch.
const IMAGE_USD = 0.05;
const CODE_IN_PER_TOKEN = 2 / 1e6;
const CODE_OUT_PER_TOKEN = 8 / 1e6;
const SIZES: Record<string, string> = { '1:1': '1024x1024', '16:9': '1536x1024', '4:3': '1536x1024', '9:16': '1024x1536', '3:4': '1024x1536' };

const license = { commercialUse: true, note: 'OpenAI Services Agreement: customer owns output; subject to usage policies.' };

const codeModel = (modality: 'website' | 'app' | 'game'): ProviderModel => ({
  id: `openai:${config.OPENAI_CODE_MODEL}:${modality}`,
  providerId: 'openai',
  model: config.OPENAI_CODE_MODEL,
  modality,
  label: `OpenAI ${config.OPENAI_CODE_MODEL}`,
  quality: 8,
  license,
  estimateCostUsd: (prompt) => (estimateTokens(prompt) + 400) * CODE_IN_PER_TOKEN + CODEGEN_MAX_OUTPUT_TOKENS * CODE_OUT_PER_TOKEN,
});

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  name: 'OpenAI',
  isConfigured: () => Boolean(config.OPENAI_API_KEY),
  models: () => [
    {
      id: 'openai:gpt-image-1', providerId: 'openai', model: 'gpt-image-1', modality: 'image',
      label: 'OpenAI GPT Image', quality: 9, license, estimateCostUsd: () => IMAGE_USD,
    },
    codeModel('website'),
    codeModel('app'),
    codeModel('game'),
  ],
  async run(model, req, signal) {
    if (model.modality === 'image') {
      const res = await providerFetch('openai', `${BASE}/images/generations`, {
        method: 'POST', headers: headers(), signal,
        body: JSON.stringify({ model: model.model, prompt: req.prompt, n: 1, size: SIZES[req.params.aspectRatio ?? '1:1'], quality: 'medium' }),
      });
      const json = (await res.json()) as { data?: { b64_json?: string }[] };
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new ProviderError('openai: empty image response', 'retriable');
      return { files: [{ filename: 'image.png', contentType: 'image/png', data: Buffer.from(b64, 'base64') }] };
    }
    const res = await providerFetch('openai', `${BASE}/chat/completions`, {
      method: 'POST', headers: headers(), signal,
      body: JSON.stringify({
        model: model.model,
        max_completion_tokens: CODEGEN_MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: codegenSystemPrompt(model.modality) },
          { role: 'user', content: req.prompt },
        ],
      }),
    });
    const json = (await res.json()) as {
      choices?: { message?: { content?: string; refusal?: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const msg = json.choices?.[0]?.message;
    if (msg?.refusal) throw new ProviderError(`openai: refused: ${msg.refusal.slice(0, 200)}`, 'rejected');
    const files = parseCodegenFiles('openai', msg?.content ?? '');
    const costUsd = json.usage
      ? json.usage.prompt_tokens * CODE_IN_PER_TOKEN + json.usage.completion_tokens * CODE_OUT_PER_TOKEN
      : undefined;
    return { files, costUsd };
  },
};

/** Returns true when the prompt is flagged by OpenAI's moderation endpoint (free to use). */
export async function moderatePrompt(prompt: string): Promise<{ flagged: boolean; categories: string[] }> {
  if (!config.OPENAI_API_KEY) return { flagged: false, categories: [] };
  const res = await providerFetch('openai-moderation', `${BASE}/moderations`, {
    method: 'POST', headers: headers(), signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ model: 'omni-moderation-latest', input: prompt }),
  });
  const json = (await res.json()) as { results?: { flagged: boolean; categories: Record<string, boolean> }[] };
  const r = json.results?.[0];
  return { flagged: Boolean(r?.flagged), categories: Object.entries(r?.categories ?? {}).filter(([, v]) => v).map(([k]) => k) };
}
