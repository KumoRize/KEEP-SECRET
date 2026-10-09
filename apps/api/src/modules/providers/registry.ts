import { pool } from '../../db/pool.js';
import { anthropicAdapter } from './adapters/anthropic.js';
import { elevenlabsAdapter } from './adapters/elevenlabs.js';
import { falAdapter } from './adapters/fal.js';
import { openrouterAdapter } from './adapters/openrouter.js';
import { mockAdapter } from './adapters/mock.js';
import { openaiAdapter } from './adapters/openai.js';
import { replicateAdapter } from './adapters/replicate.js';
import { stabilityAdapter } from './adapters/stability.js';
import type { ProviderAdapter, ProviderModel } from './types.js';

/**
 * To add a provider: implement ProviderAdapter in ./adapters, then add it here.
 * Routing, pricing, fallback, credits and the admin UI pick it up automatically.
 */
const adapters = new Map<string, ProviderAdapter>();
for (const a of [anthropicAdapter, openaiAdapter, stabilityAdapter, replicateAdapter, elevenlabsAdapter, falAdapter, openrouterAdapter, mockAdapter]) {
  adapters.set(a.id, a);
}

export function registerAdapter(adapter: ProviderAdapter): void {
  if (adapters.has(adapter.id)) throw new Error(`Provider ${adapter.id} already registered`);
  adapters.set(adapter.id, adapter);
}

export const getAdapter = (id: string) => adapters.get(id);
export const listAdapters = () => [...adapters.values()];

export function configuredModels(): ProviderModel[] {
  return listAdapters().filter((a) => a.isConfigured()).flatMap((a) => a.models());
}

export function findModel(id: string): ProviderModel | undefined {
  return configuredModels().find((m) => m.id === id);
}

export interface ProviderSetting {
  enabled: boolean;
  priority: number;
}

let cache: { at: number; data: Map<string, ProviderSetting> } | null = null;

/** Admin-controlled enable/priority overrides, cached briefly to keep routing off the hot DB path. */
export async function providerSettings(): Promise<Map<string, ProviderSetting>> {
  if (cache && Date.now() - cache.at < 15_000) return cache.data;
  const { rows } = await pool.query<{ provider_id: string; enabled: boolean; priority: number }>(
    'SELECT provider_id, enabled, priority FROM provider_settings',
  );
  const data = new Map(rows.map((r) => [r.provider_id, { enabled: r.enabled, priority: r.priority }]));
  cache = { at: Date.now(), data };
  return data;
}

export function invalidateProviderSettings(): void {
  cache = null;
}
