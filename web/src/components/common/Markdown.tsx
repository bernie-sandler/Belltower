import { useMemo } from 'react';
import { renderMarkdown } from '../../lib/markdown';
import { cls } from '../../lib/cls';

/** Rendered Markdown (see lib/markdown.ts for why this HTML is safe to insert). */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={cls('markdown', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
