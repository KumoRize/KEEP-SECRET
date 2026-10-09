// Minimal stroke icon set (24px grid, inherits currentColor).
const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9zM5 15l.6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z',
  bot: 'M12 3v3M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3zM9 13h.01M15 13h.01M9.5 17h5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  library: 'M4 4h5v16H4zM10 4h5v16h-5zM16.5 5.2l4.6 1.2-3.9 14.4-4.6-1.2z',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14h.01',
  code: 'M8 8l-5 4 5 4M16 8l5 4-5 4M14 4l-4 16',
  key: 'M14 7a4 4 0 1 1-3.5 6L4 19.5V22h2.5l1-1v-2h2v-2h2l1.2-1.2A4 4 0 0 1 14 7zM16 9h.01',
  shield: 'M12 3l8 3v6c0 4.6-3.4 8.3-8 9-4.6-.7-8-4.4-8-9V6z',
  image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9h.01',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  cube: 'M12 2l9 5v10l-9 5-9-5V7zM12 22V12M21 7l-9 5-9-5',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  layout: 'M3 4h18v16H3zM3 9h18M9 9v11',
  phone: 'M7 2h10v20H7zM11 18h2',
  gamepad: 'M6 9h12a4 4 0 0 1 0 8 3 3 0 0 1-2.4-1.2L14 14h-4l-1.6 1.8A3 3 0 0 1 6 17a4 4 0 0 1 0-8zM8 11v4M6 13h4M15 12h.01M17 14h.01',
  book: 'M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z',
  telescope: 'M10 14l-6 7M14 14l4 7M3 10l15-6 2 5-15 6zM14 14a2 2 0 1 1-4 0',
  menu: 'M4 6h16M4 12h16M4 18h16',
  plus: 'M12 5v14M5 12h14',
  send: 'M4 12l16-8-6 16-2-7z',
  stop: 'M7 7h10v10H7z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  gift: 'M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-1-3-5-3-5-1s5 1 5 1zM12 7c1-3 5-3 5-1s-5 1-5 1z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6 6 18',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  refresh: 'M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4',
};

export function Icon({ name, size = 20, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.sparkles} />
    </svg>
  );
}

/** Gradient definition referenced by active nav icons. Render once. */
export function IconDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <linearGradient id="g-accent" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" /><stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export const CATEGORY_META: Record<string, { label: string; icon: string; color: string; blurb: string }> = {
  image: { label: 'Image', icon: 'image', color: '#8b5cf6', blurb: 'Photos, art, logos, posters' },
  video: { label: 'Video', icon: 'video', color: '#ec4899', blurb: 'Cinematic clips with motion and audio' },
  '3d': { label: '3D', icon: 'cube', color: '#f59e0b', blurb: 'Meshes and game assets' },
  music: { label: 'Music', icon: 'music', color: '#10b981', blurb: 'Songs, beats and soundtracks' },
  website: { label: 'Website', icon: 'layout', color: '#06b6d4', blurb: 'Landing pages and sites' },
  app: { label: 'App', icon: 'phone', color: '#6366f1', blurb: 'Tools and mini apps' },
  game: { label: 'Game', icon: 'gamepad', color: '#f43f5e', blurb: 'Playable browser games' },
  chat: { label: 'Chat', icon: 'chat', color: '#a855f7', blurb: 'Ask anything' },
  story: { label: 'Story', icon: 'book', color: '#fb923c', blurb: 'Stories, scripts and scenarios' },
  code: { label: 'Code', icon: 'code', color: '#22c55e', blurb: 'Write, explain and fix code' },
  research: { label: 'Research', icon: 'telescope', color: '#0ea5e9', blurb: 'Web search with citations' },
};
