import type { GenerationParams, Modality } from '../providers/types.js';

export interface Intent {
  modality: Modality;
  confidence: number; // 0..1
  params: GenerationParams;
  scores: Record<Modality, number>;
}

// Weighted keyword rules. Phrases that strongly imply a modality score higher than generic nouns.
const RULES: Record<Modality, [RegExp, number][]> = {
  video: [
    [/\b(video|videos|clip|footage|trailer|reel|reels|b-?roll|timelapse|time-lapse|cinematic shot|short film)\b/, 3],
    [/\b(animate|animated|animation|motion)\b/, 1.5],
    [/\b\d+\s*(s|sec|secs|seconds?)\s+(video|clip)\b/, 2],
  ],
  '3d': [
    [/\b(3d|3-d|three[- ]dimensional)\b/, 3],
    [/\b(mesh|glb|gltf|obj file|low[- ]poly|sculpt|printable|game asset)\b/, 2],
  ],
  website: [
    [/\b(website|web ?site|landing page|homepage|home page|portfolio site|web page|webpage|blog site)\b/, 3],
    [/\b(html|seo|hero section|navbar)\b/, 1],
  ],
  app: [
    [/\b(app|application|web app|tool|dashboard|tracker|calculator|todo|to-do|crm|planner|converter)\b/, 2],
    [/\b(crud|login form|form builder)\b/, 1],
  ],
  game: [
    [/\b(game|games|platformer|arcade|puzzle game|snake|tetris|pong|shooter|endless runner|rpg|playable)\b/, 3],
  ],
  music: [
    [/\b(song|music|track|beat|beats|melody|soundtrack|jingle|instrumental|lo-?fi|hip[- ]hop beat|ambient|bgm|tune)\b/, 3],
    [/\b(bpm|chorus|verse|guitar|piano|synth|drums)\b/, 1],
  ],
  image: [
    [/\b(image|picture|photo|photograph|illustration|logo|poster|wallpaper|drawing|painting|portrait|icon|artwork|thumbnail|sticker)\b/, 3],
    [/\b(draw|paint|render of|digital art|watercolor|oil painting)\b/, 1.5],
  ],
};

// When rules tie, prefer the more specific output.
const TIE_ORDER: Modality[] = ['game', 'website', '3d', 'video', 'music', 'app', 'image'];

function extractParams(text: string, modality: Modality): GenerationParams {
  const params: GenerationParams = {};
  const dur = text.match(/\b(\d{1,3})\s*(s|sec|secs|seconds?|min|mins|minutes?)\b/);
  if (dur && (modality === 'video' || modality === 'music')) {
    const n = Number(dur[1]);
    params.durationSec = /^m/.test(dur[2]!) ? n * 60 : n;
  }
  if (/\b(16:9|landscape|widescreen|youtube)\b/.test(text)) params.aspectRatio = '16:9';
  else if (/\b(9:16|portrait|vertical|story|stories|reels?|shorts|tiktok)\b/.test(text)) params.aspectRatio = '9:16';
  else if (/\b(1:1|square)\b/.test(text)) params.aspectRatio = '1:1';
  return params;
}

/** Fast, free, deterministic intent detection. Callers may override with an explicit modality. */
export function detectIntent(prompt: string): Intent {
  const text = prompt.toLowerCase();
  const scores = Object.fromEntries(
    (Object.keys(RULES) as Modality[]).map((m) => [m, RULES[m].reduce((sum, [re, w]) => sum + (re.test(text) ? w : 0), 0)]),
  ) as Record<Modality, number>;

  // "game" mentioned alongside "3d model" means a 3D asset, not a playable game.
  if (/\b3d (model|asset)\b/.test(text)) scores.game = Math.max(0, scores.game - 3);
  // "music video" is a video.
  if (/\bmusic video\b/.test(text)) scores.music = Math.max(0, scores.music - 3);
  // A "website" is not also an "app" just because it contains the word tool/app-like nouns.
  if (scores.website >= 3) scores.app = Math.max(0, scores.app - 2);

  const ranked = TIE_ORDER.slice().sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0]!;
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  if (scores[top] === 0) {
    // Nothing matched: an image is the cheapest, most common creative request.
    return { modality: 'image', confidence: 0.3, params: extractParams(text, 'image'), scores };
  }
  return { modality: top, confidence: Math.round((scores[top] / total) * 100) / 100, params: extractParams(text, top), scores };
}
