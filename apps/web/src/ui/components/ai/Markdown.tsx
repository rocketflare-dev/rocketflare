/**
 * Markdown renderer for model output (D17). `react-markdown` + GFM, **sanitised by default**: raw
 * HTML in the source is skipped (`skipHtml`), `javascript:` URLs are dropped by react-markdown's
 * default `urlTransform`, and links open in a new tab with `rel="noopener noreferrer"`. Nothing
 * here uses `dangerouslySetInnerHTML`. Memoised: while a reply streams the parent re-renders per
 * delta and re-parsing every settled turn is what makes a long transcript stutter.
 *
 * Lives in `components/ai/` on purpose — NOT the `components/shared` barrel App.tsx imports
 * eagerly — so the markdown dependency ships only in the lazy chat chunk.
 */
import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
}

const PROSE =
  'prose prose-sm max-w-none text-inherit prose-p:my-1 prose-headings:my-2 prose-pre:my-1 ' +
  'prose-ul:my-1 prose-ol:my-1 prose-headings:text-inherit prose-strong:text-inherit ' +
  'prose-li:text-inherit prose-code:text-inherit prose-a:text-primary'

function MarkdownImpl({ content, className = '' }: { content: string; className?: string }) {
  return (
    <div className={`${PROSE} ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownImpl)
