import type { Modality, OutputFile } from './types.js';
import { ProviderError } from './types.js';

const SYSTEM: Record<'website' | 'app' | 'game', string> = {
  website:
    'You generate production-quality, responsive, accessible websites. Output a single self-contained index.html ' +
    '(inline CSS and JS, no external scripts, no tracking, no remote fonts).',
  app:
    'You generate small, working web applications. Output a self-contained index.html with inline CSS and JS ' +
    '(no external scripts). Persist state in localStorage when useful. Add a README.md explaining usage.',
  game:
    'You generate playable browser games. Output a single self-contained index.html using <canvas> and vanilla JS, ' +
    'with keyboard and touch controls, a score, and restart. No external assets or scripts.',
};

export function codegenSystemPrompt(modality: Modality): string {
  const base = SYSTEM[modality as keyof typeof SYSTEM];
  if (!base) throw new Error(`codegen does not support ${modality}`);
  return (
    `${base}\nRespond with JSON only, no markdown fences, matching: ` +
    '{"files":[{"path":"index.html","content":"..."}]}. Paths are relative, use only [a-zA-Z0-9._/-], max 20 files.'
  );
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json',
  md: 'text/markdown', txt: 'text/plain', svg: 'image/svg+xml',
};

/** Parses and validates model output; rejects path traversal and unexpected shapes. */
export function parseCodegenFiles(provider: string, text: string): OutputFile[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ProviderError(`${provider}: model returned no JSON`, 'retriable');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ProviderError(`${provider}: model returned invalid JSON`, 'retriable');
  }
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0 || files.length > 20) {
    throw new ProviderError(`${provider}: expected 1-20 files`, 'retriable');
  }
  return files.map((f) => {
    const { path, content } = (f ?? {}) as { path?: unknown; content?: unknown };
    if (typeof path !== 'string' || typeof content !== 'string') throw new ProviderError(`${provider}: bad file entry`, 'retriable');
    if (!/^[a-zA-Z0-9._/-]{1,120}$/.test(path) || path.split('/').some((seg) => seg === '..' || seg === '') || path.startsWith('/')) {
      throw new ProviderError(`${provider}: unsafe file path`, 'retriable');
    }
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return { filename: path, contentType: CONTENT_TYPES[ext] ?? 'text/plain', data: Buffer.from(content, 'utf8') };
  });
}

/** Rough token estimate (~4 chars/token) used only for pre-generation quotes. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
export const CODEGEN_MAX_OUTPUT_TOKENS = 16000;
