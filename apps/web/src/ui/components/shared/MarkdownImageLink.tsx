/**
 * The `img` renderer for Markdown written by a model or taken from a document: pass it as
 * `components={{ img: MarkdownImageLink }}`. It shows the image as a link, so opening the page
 * fetches nothing the text named; following the address is the reader's choice. An address the
 * renderer refused (`javascript:` and the like) arrives empty and leaves only the description.
 *
 * Free of any markdown import, so it can sit in the eager `components/shared` barrel.
 */
import type { ComponentProps } from 'react'

export function MarkdownImageLink({ src, alt }: Pick<ComponentProps<'img'>, 'src' | 'alt'>) {
  if (!src) return <>{alt}</>
  return (
    <a href={src} target="_blank" rel="noopener noreferrer">
      {alt || src}
    </a>
  )
}
