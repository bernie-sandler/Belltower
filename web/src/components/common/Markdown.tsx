import { useMemo } from 'react';
import { renderMarkdown, type MentionPeople } from '../../lib/markdown';
import { cls } from '../../lib/cls';

/** Rendered Markdown (see lib/markdown.ts for why this HTML is safe to insert). `people`: highlight @mentions of them. */
export function Markdown({ text, className, people }: { text: string; className?: string; people?: MentionPeople }) {
  const html = useMemo(() => renderMarkdown(text, { people }), [text, people]);
  return <div className={cls('markdown', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
