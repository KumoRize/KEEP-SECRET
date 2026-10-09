import { config } from '../../../config.js';
import { cachedCatalog, type CatalogRow } from '../../catalog/catalog.js';
import { codegenSystemPrompt, CODEGEN_MAX_OUTPUT_TOKENS, estimateTokens, parseCodegenFiles } from '../codegen.js';
import { providerFetch } from '../http.js';
import type { Modality, ProviderAdapter, ProviderModel } from '../types.js';
import { ProviderError } from '../types.js';

/** Website/app/game generation through any OpenRouter text model in the catalog (chat lives in modules/text). */
const CODEGEN: Modality[] = ['website', 'app', 'game'];

export const openrouterHeaders = () => ({
  Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
  'Content-Type': 'application/json',
  // Optional attribution headers recognised by OpenRouter.
  'HTTP-Referer': config.PUBLIC_URL,
  'X-Title': config.APP_NAME,
});

export function textCostUsd(row: Pick<CatalogRow, 'pricing' | 'is_free'>, inTok: number, outTok: number): number {
  if (row.is_free) return 0;
  return (inTok * (row.pricing.inputPerMTok ?? 0) + outTok * (row.pricing.outputPerMTok ?? 0)) / 1e6;
}

function toModel(row: CatalogRow, modality: Modality): ProviderModel {
  return {
    id: `${row.id}#${modality}`, providerId: 'openrouter', model: row.model, modality, label: row.label, quality: row.quality,
    license: { commercialUse: row.commercial_use, note: [row.license_note, row.data_note].filter(Boolean).join(' ') },
    free: row.is_free,
    estimateCostUsd: (prompt) => textCostUsd(row, estimateTokens(prompt) + 400, CODEGEN_MAX_OUTPUT_TOKENS),
  };
}

export const openrouterAdapter: ProviderAdapter = {
  id: 'openrouter',
  name: 'OpenRouter',
  isConfigured: () => Boolean(config.OPENROUTER_API_KEY),
  models: () => cachedCatalog()
    .filter((r) => r.provider_id === 'openrouter' && r.enabled)
    .flatMap((r) => r.categories.filter((c) => CODEGEN.includes(c as Modality)).map((c) => toModel(r, c as Modality))),
  async run(model, req, signal) {
    const res = await providerFetch('openrouter', 'https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: openrouterHeaders(), signal,
      body: JSON.stringify({
        model: model.model,
        max_tokens: CODEGEN_MAX_OUTPUT_TOKENS,
        usage: { include: true },
        messages: [{ role: 'system', content: codegenSystemPrompt(model.modality) }, { role: 'user', content: req.prompt }],
      }),
    });
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      error?: { message?: string; code?: number };
    };
    if (json.error) throw new ProviderError(`openrouter: ${json.error.message ?? 'error'}`, json.error.code === 400 ? 'rejected' : 'retriable');
    const choice = json.choices?.[0];
    if (choice?.finish_reason === 'content_filter') throw new ProviderError('openrouter: blocked by content filter', 'rejected');
    const files = parseCodegenFiles('openrouter', choice?.message?.content ?? '');
    const row = cachedCatalog().find((r) => r.id === model.id.split('#')[0]);
    const costUsd = json.usage?.cost ?? (row && json.usage
      ? textCostUsd(row, json.usage.prompt_tokens ?? 0, json.usage.completion_tokens ?? 0) : undefined);
    return { files, costUsd };
  },
};
