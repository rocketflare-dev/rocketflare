/**
 * Markdown renderer for model output. `react-markdown` + GFM, **sanitised by default**: raw
 * HTML in the source is skipped (`skipHtml`), `javascript:` URLs are dropped by react-markdown's
 * default `urlTransform`, and links open in a new tab with `rel="noopener noreferrer"`. Nothing
 * here uses `dangerouslySetInnerHTML`. Memoised: while a reply streams the parent re-renders per
 * delta and re-parsing every settled turn is what makes a long transcript stutter.
 *
 * ONE exception to "a link is an `<a>`": a link to this app's own document viewer
 * (`/documents/<uuid>`) renders as a `ProvenanceLink` — the document's type icon, the link text and
 * its type — so `research-topic`'s markdown answer cites documents inline, the same way its
 * Sources list does, rather than as bare in-app URLs opened in a new tab. Never a card: a card
 * inside the answer's own panel doubles every edge. The document's card is fetched by id for its
 * type; the link works while it loads, and after the document has been deleted.
 *
 * An image renders as a link (`MarkdownImageLink`): this text comes from a model or a document, and
 * an `<img>` would have the browser fetch whatever address it names as soon as the page is open.
 *
 * Lives in `components/ai/` on purpose — NOT the `components/shared` barrel App.tsx imports
 * eagerly — so the markdown dependency ships only in the lazy chat / agents / documents chunks.
 */
import { isValidElement, memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Link } from 'react-router'
import remarkGfm from 'remark-gfm'
import { MarkdownImageLink, ProvenanceLink } from '@/ui/components/shared'
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
    <ProvenanceLink
      className="not-prose"
      source={{
        id,
        to: href,
        title: textOf(children) || card.data.title,
        typeLabel: card.data.typeLabel,
        status: card.data.status,
      }}
    />
  )
}

/** The plain words under a node (the link's own words, a table cell's text). */
function textOf(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(textOf).join('')
  if (isValidElement<{ children?: React.ReactNode }>(children))
    return textOf(children.props.children)
  return ''
}

/**
 * A cell this short is a token — an id, a status, a number — and breaking it across lines
 * ("MAJ-" / "2") reads as two values. Longer cells wrap as prose.
 */
const UNBROKEN_CELL_CHARS = 24

function cellClass(children: React.ReactNode): string | undefined {
  return textOf(children).length <= UNBROKEN_CELL_CHARS ? 'whitespace-nowrap' : undefined
}

const COMPONENTS: Components = {
  img: MarkdownImageLink,
  // A wide table scrolls inside its own box instead of pushing the answer past the screen edge.
  table: ({ node: _node, ...props }) => (
    <div className="my-3 overflow-x-auto">
      <table {...props} />
    </div>
  ),
  th: ({ node: _node, children, ...props }) => (
    <th {...props} className={cellClass(children)}>
      {children}
    </th>
  ),
  td: ({ node: _node, children, ...props }) => (
    <td {...props} className={cellClass(children)}>
      {children}
    </td>
  ),
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
  'prose prose-sm text-inherit prose-table:my-0 prose-headings:text-inherit ' +
  'prose-strong:text-inherit prose-li:text-inherit prose-code:text-inherit prose-a:text-primary'

/**
 * `compact` for a chat bubble or a timeline row, where blocks sit tight; `reading` for an answer
 * or a document somebody reads top to bottom, where a paragraph needs room to read as one.
 */
const SPACING = {
  compact: 'prose-p:my-1 prose-headings:my-2 prose-pre:my-1 prose-ul:my-1 prose-ol:my-1',
  reading:
    'prose-p:my-[0.75em] prose-headings:mt-[1.25em] prose-headings:mb-[0.5em] ' +
    'prose-pre:my-[0.75em] prose-ul:my-[0.75em] prose-ol:my-[0.75em] ' +
    '[&>:first-child]:mt-0 [&>:last-child]:mb-0',
} as const

function MarkdownImpl({
  content,
  className = '',
  spacing = 'compact',
}: {
  content: string
  className?: string
  spacing?: keyof typeof SPACING
}) {
  return (
    // The caller may set the measure (`max-w-[72ch]` for an answer); otherwise it fills its box.
    <div
      className={`${PROSE} ${SPACING[spacing]} ${/\bmax-w-/.test(className) ? '' : 'max-w-none'} ${className}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownImpl)
