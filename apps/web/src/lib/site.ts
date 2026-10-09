import { useEffect, useState } from 'react';

export interface SiteInfo { appName: string; announcement: string; maintenance: boolean; maintenanceMessage: string; signupsOpen: boolean }

let cached: SiteInfo | null = null;
const listeners = new Set<(s: SiteInfo) => void>();

export async function refreshSite(): Promise<SiteInfo | null> {
  try {
    const r = await fetch('/api/v1/site', { credentials: 'same-origin' });
    if (!r.ok) return cached;
    cached = (await r.json()) as SiteInfo;
    listeners.forEach((l) => l(cached!));
  } catch { /* offline: keep last known */ }
  return cached;
}

/** Public site switches (announcement, maintenance, sign-ups), refreshed every minute. */
export function useSite(): SiteInfo | null {
  const [site, setSite] = useState<SiteInfo | null>(cached);
  useEffect(() => {
    listeners.add(setSite);
    void refreshSite();
    const t = window.setInterval(() => void refreshSite(), 60_000);
    return () => { listeners.delete(setSite); window.clearInterval(t); };
  }, []);
  return site;
}
