import { Marked } from 'marked';
import { sanitizeGlossaryHtml } from '../dict/glossary';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const markdown = new Marked({
  async: false, gfm: true, breaks: true,
  renderer: {
    // Model output is prose. Raw HTML stays text, images never load external resources.
    html({ text }) { return escapeHtml(text); },
    image({ text }) { return escapeHtml(text); },
    link({ href, tokens }) {
      return `<span class="markdown-link" title="${escapeHtml(href)}">${this.parser.parseInline(tokens)}</span>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return sanitizeGlossaryHtml(markdown.parse(text, { async: false }));
}
