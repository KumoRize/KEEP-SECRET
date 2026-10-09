import { useEffect, useState } from 'react';
import { api } from '../api';

export interface CatalogModel {
  id: string;
  provider: string;
  label: string;
  description: string;
  categories: string[];
  tags: string[];
  isFree: boolean;
  featured: boolean;
  quality: number;
  contextLength: number | null;
  maxDurationSec: number | null;
  priceHint: string;
  creditsPerUnit: number;
  unit: string;
  commercialUse: boolean;
  licenseNote: string;
  dataNote: string;
}

interface CatalogState { at: number; items: CatalogModel[]; counts: Record<string, number> }
let cached: CatalogState | null = null;
let inflight: Promise<CatalogState> | null = null;

export function loadModels(): Promise<CatalogState> {
  if (cached && Date.now() - cached.at < 60_000) return Promise.resolve(cached);
  inflight ??= api<{ items: CatalogModel[]; counts: Record<string, number> }>('/catalog/models')
    .then((r): CatalogState => (cached = { at: Date.now(), ...r }))
    .finally(() => { inflight = null; });
  return inflight;
}

/** Shared, cached catalog of every runnable model. */
export function useModels() {
  const [state, setState] = useState<{ items: CatalogModel[]; counts: Record<string, number>; loading: boolean }>(
    { items: cached?.items ?? [], counts: cached?.counts ?? {}, loading: !cached },
  );
  useEffect(() => {
    let live = true;
    loadModels().then((r) => live && setState({ items: r.items, counts: r.counts, loading: false })).catch(() => live && setState((s) => ({ ...s, loading: false })));
    return () => { live = false; };
  }, []);
  return state;
}

const PROVIDER_COLORS: Record<string, string> = {
  openrouter: 'linear-gradient(135deg,#6366f1,#22d3ee)', fal: 'linear-gradient(135deg,#ec4899,#f59e0b)',
  anthropic: 'linear-gradient(135deg,#d97757,#f4b183)', openai: 'linear-gradient(135deg,#10a37f,#34d399)',
  stability: 'linear-gradient(135deg,#8b5cf6,#c084fc)', replicate: 'linear-gradient(135deg,#334155,#64748b)',
  elevenlabs: 'linear-gradient(135deg,#111827,#6b7280)', mock: 'linear-gradient(135deg,#8b5cf6,#22d3ee)',
};
export const providerGradient = (p: string) => PROVIDER_COLORS[p] ?? 'linear-gradient(135deg,#8b5cf6,#ec4899)';
export const initials = (label: string) => label.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || 'AI';
