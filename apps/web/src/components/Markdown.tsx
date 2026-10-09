import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useRef } from 'react';

marked.setOptions({ gfm: true, breaks: true });

// Links from model output open safely in a new tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

/** Renders model output as sanitized Markdown. Raw HTML from the model is stripped of scripts and handlers. */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] }),
    [text],
  );

  // Copy buttons on code blocks (added after render so the sanitized HTML stays untouched).
  useEffect(() => {
    if (streaming || !ref.current) return;
    ref.current.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.copy')) return;
      const btn = document.createElement('button');
      btn.className = 'copy';
      btn.type = 'button';
      btn.textContent = 'Copy';
      btn.onclick = () => {
        void navigator.clipboard?.writeText(pre.querySelector('code')?.textContent ?? '');
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      };
      pre.appendChild(btn);
    });
  }, [html, streaming]);

  return <div ref={ref} className={`md${streaming ? ' typing' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
