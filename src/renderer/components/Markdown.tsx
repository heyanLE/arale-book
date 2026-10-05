import { useMemo } from 'react';
import { renderMarkdown } from '@core/cards/markdown';

export function Markdown({ text, className = '' }: { text: string; className?: string }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`markdown-body ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
