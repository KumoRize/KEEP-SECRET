import { describe, expect, it } from 'vitest';
import { detectIntent } from '../src/modules/orchestrator/intent.js';

describe('detectIntent', () => {
  it.each([
    ['A watercolor painting of a tiger at sunset', 'image'],
    ['Logo for a coffee shop called Brew Lab', 'image'],
    ['10 second cinematic video of waves crashing', 'video'],
    ['3D model of a low poly treasure chest', '3d'],
    ['Landing page for my yoga studio with pricing section', 'website'],
    ['Build a budget tracker app with charts', 'app'],
    ['Make a snake game with neon colors', 'game'],
    ['Upbeat lofi hip-hop beat for studying, 60 seconds', 'music'],
    ['Music video for an indie band', 'video'],
    ['3D model of a game character', '3d'],
  ])('%s -> %s', (prompt, modality) => {
    expect(detectIntent(prompt).modality).toBe(modality);
  });

  it('falls back to image with low confidence when nothing matches', () => {
    const i = detectIntent('a cozy cabin in the snowy mountains');
    expect(i.modality).toBe('image');
    expect(i.confidence).toBeLessThan(0.5);
  });

  it('extracts duration and aspect ratio', () => {
    expect(detectIntent('2 min ambient soundtrack').params.durationSec).toBe(120);
    expect(detectIntent('8s vertical video of a city at night for reels').params).toEqual({ durationSec: 8, aspectRatio: '9:16' });
  });

  it('ignores durations for non time-based outputs', () => {
    expect(detectIntent('website that loads in 2 seconds').params.durationSec).toBeUndefined();
  });
});
