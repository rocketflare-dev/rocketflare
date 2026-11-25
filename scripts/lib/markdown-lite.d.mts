/** Types for `markdown-lite.mjs` (no `allowJs`); `apps/web/tests/kit-only/design-docs.test.ts` typechecks against this. */
export interface MarkdownHooks {
  link?: (dest: string) => string | null
  image?: (src: string, alt: string, title: string | null, standalone: boolean) => string | null
}
export interface HeadingBlock {
  level: number
  text: string
  id: string
  toString(): string
}
export function escapeHtml(s: string): string
export function plainText(s: string): string
export function slugify(s: string): string
export function renderInline(s: string, hooks?: MarkdownHooks, inLink?: boolean): string
export function renderMarkdown(
  src: string,
  hooks?: MarkdownHooks
): { blocks: Array<string | HeadingBlock> }
