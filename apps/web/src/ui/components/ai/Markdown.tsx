/**
 * Markdown renderer for model output (D17). `react-markdown` + GFM, **sanitised by default**: raw
 * HTML in the source is skipped (`skipHtml`), `javascript:` URLs are dropped by react-markdown's
 * default `urlTransform`, and links open in a new tab with `rel="noopener noreferrer"`. Nothing
 * here uses `dangerouslySetInnerHTML`. Memoised: while a reply streams the parent re-renders per
 * delta and re-parsing every settled turn is what makes a long transcript stutter.
 *
 * ONE exception to "a link is an `<a>`": a link to this app's own document viewer
 * (`/documents/<uuid>`) renders as a `DocumentCard` (D18), so `research-topic`'s markdown answer
 * cites documents as cards rather than as bare in-app URLs opened in a new tab. The card is fetched
 * by id, degrades to a plain in-app `<Link>` while it loads or if the document has since been
 * deleted, and — being markdown-free itself — lives in the eager `components/shared` barrel.
 *
 * Lives in `components/ai/` on purpose — NOT the `components/shared` barrel App.tsx imports
 * eagerly — so the markdown dependency ships only in the lazy chat / agents / documents chunks.
 */
import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Link } from 'react-router-dom'
import remarkGfm from 'remark-gfm'
import { DocumentCard } from '@/ui/components/shared'
import { useDocumentCard } from '@/ui/hooks/useDocuments'

/** `/documents/<uuid>` with an optional query — the shape `documentPath()` writes. */
const DOCUMENT_HREF =
  /^\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#]|$)/i

export function documentIdFromHref(href: string | undefined): string | null {
  return href ? (DOCUMENT_HREF.exec(href)?.[1] ?? null) : null
}

function DocumentLink({ href, children }: { href: string; children: React.ReactNode }) {
  const id = documentIdFromHref(href) as string
  const card = useDocumentCard(id)
  // Not yet loaded, or gone (deleted since the run): the title is still a working in-app link.
  if (!card.data) {
    return (
      <Link to={href} className="link link-primary">
        {children}
      </Link>
    )
  }
  return (
    <span className="block my-2 not-prose">
      <DocumentCard card={card.data} to={href} dense />
    </span>
  )
}

const COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...props }) =>
    documentIdFromHref(href) ? (
      <DocumentLink href={href as string}>{children}</DocumentLink>
    ) : (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
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
