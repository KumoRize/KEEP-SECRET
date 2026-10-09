import { config } from '../../config.js';
import { providerFetch } from '../providers/http.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const searchConfigured = () => Boolean(config.TAVILY_API_KEY || config.BRAVE_SEARCH_API_KEY || config.ENABLE_MOCK_PROVIDER);

const clean = (s: unknown, max: number) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const httpOnly = (r: SearchResult) => /^https?:\/\//.test(r.url);

/** Web search through the first configured engine: Tavily, then Brave (mock in development). */
export async function webSearch(query: string, max = 6, signal = AbortSignal.timeout(15_000)): Promise<SearchResult[]> {
  const q = query.slice(0, 400);
  if (config.TAVILY_API_KEY) {
    const res = await providerFetch('tavily', 'https://api.tavily.com/search', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${config.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, max_results: max, search_depth: 'basic' }),
    });
    const json = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (json.results ?? []).map((r) => ({ title: clean(r.title, 200), url: String(r.url ?? ''), snippet: clean(r.content, 700) })).filter(httpOnly).slice(0, max);
  }
  if (config.BRAVE_SEARCH_API_KEY) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${max}`;
    const res = await providerFetch('brave', url, {
      signal, headers: { Accept: 'application/json', 'X-Subscription-Token': config.BRAVE_SEARCH_API_KEY },
    });
    const json = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (json.web?.results ?? []).map((r) => ({ title: clean(r.title, 200), url: String(r.url ?? ''), snippet: clean(r.description, 700) })).filter(httpOnly).slice(0, max);
  }
  if (config.ENABLE_MOCK_PROVIDER) {
    return [1, 2, 3].map((n) => ({ title: `Mock source ${n} about ${clean(q, 60)}`, url: `https://example.com/source-${n}`, snippet: `Mock finding ${n} for "${clean(q, 80)}".` }));
  }
  throw new Error('No web search provider configured (set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY)');
}

/** System-prompt block that numbers sources so the model can cite them as [1], [2], ... */
export function sourcesBlock(results: SearchResult[]): string {
  return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
}
