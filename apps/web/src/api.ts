export interface Plan {
  id: string; name: string; priceInr: number; monthlyCredits: number; modalities: string[];
  dailyGenerations: number; maxConcurrent: number; maxVideoSeconds: number; commercialUse: boolean;
}
export interface Balance { subscription: number; purchased: number; total: number }
export interface Me { user: { id: string; email: string; role: string; emailVerified: boolean; plan: Plan }; balance: Balance }
export interface Asset { id: string; filename: string; content_type: string; size_bytes: number; url: string; previewUrl: string }
export interface Generation {
  id: string; prompt: string; modality: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  heldCredits: number; chargedCredits: number | null; provider: string | null; model: string | null;
  licenseNote: string | null; error: string | null; createdAt: string; assets: Asset[]; projectId: string | null;
}
export interface Quote {
  quoteToken: string; modality: string; detected: { modality: string; confidence: number };
  params: { durationSec?: number; aspectRatio?: string }; provider: { modelId: string; label: string };
  estimatedCredits: number; maxCredits: number; fallbacks: { modelId: string; label: string; credits: number }[];
  licenseNote: string; expiresAt: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

// Access token lives in memory only; the refresh token is an httpOnly cookie.
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
export const setAccessToken = (t: string | null) => { accessToken = t; };
export const authHeaders = (): Record<string, string> => (accessToken ? { Authorization: `Bearer ${accessToken}` } : {});

export async function tryRefresh(): Promise<boolean> {
  refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': '1' } })
    .then(async (r) => {
      if (!r.ok) return false;
      accessToken = (await r.json()).accessToken;
      return true;
    })
    .catch(() => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown; idempotencyKey?: string } = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.json !== undefined) headers.set('Content-Type', 'application/json');
  if (init.idempotencyKey) headers.set('Idempotency-Key', init.idempotencyKey);
  headers.set('X-Requested-With', '1');
  const res = await fetch(`/api/v1${path}`, {
    ...init, headers, credentials: 'same-origin', body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await tryRefresh()) return api<T>(path, init, false);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return body as T;
}

export const MODALITY_LABELS: Record<string, string> = {
  image: 'Image', video: 'Video', '3d': '3D Model', website: 'Website', app: 'App', game: 'Game', music: 'Music',
};
