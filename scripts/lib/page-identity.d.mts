/** Hand-written types for `page-identity.mjs` (the workspace has no `allowJs`). */
export interface PageIdentity {
  title: string
  description: string
}
export function pageIdentity(tomlText: string): PageIdentity | null
export function applyPageIdentity(html: string, identity: PageIdentity | null): string
