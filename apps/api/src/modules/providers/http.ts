import { ProviderError } from './types.js';

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export function classifyStatus(status: number): ProviderError['kind'] {
  if (status === 401 || status === 403 || status === 404) return 'unavailable';
  if (status === 400 || status === 422) return 'rejected';
  return 'retriable'; // 408, 409, 429, 5xx
}

/** fetch wrapper that maps transport and HTTP failures onto ProviderError kinds. */
export async function providerFetch(provider: string, url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (init.signal.aborted) throw new ProviderError(`${provider}: timed out`, 'retriable');
    throw new ProviderError(`${provider}: network error: ${(err as Error).message}`, 'retriable');
  }
  if (!res.ok) {
    // Provider error bodies may echo request data; keep a short excerpt only.
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new ProviderError(`${provider}: HTTP ${res.status} ${body}`, classifyStatus(res.status), res.status);
  }
  return res;
}

export async function downloadBinary(provider: string, url: string, signal: AbortSignal): Promise<{ data: Buffer; contentType: string }> {
  if (!url.startsWith('https://')) throw new ProviderError(`${provider}: refusing non-https output URL`, 'retriable');
  const res = await providerFetch(provider, url, { signal });
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new ProviderError(`${provider}: output too large`, 'rejected');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_DOWNLOAD_BYTES) throw new ProviderError(`${provider}: output too large`, 'rejected');
  return { data, contentType: res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' };
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ProviderError('aborted', 'retriable'));
    }, { once: true });
  });
