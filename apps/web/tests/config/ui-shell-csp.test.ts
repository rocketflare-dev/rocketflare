import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Once a plugin declares `publicSites`, app navigations reach the Worker and `index.html` picks up
 * its `script-src 'self'`, so an inline script in the shell would silently stop running.
 */
describe('the UI shell is CSP-clean', () => {
  const html = readFileSync(resolve(__dirname, '../../src/ui/index.html'), 'utf8')

  it('has no inline script', () => {
    const tags = html.match(/<script\b[^>]*>/g) ?? []
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) expect(tag).toMatch(/\bsrc=/)
  })

  it('loads no external script', () => {
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
      expect(tag).not.toMatch(/src=["'](https?:)?\/\//)
    }
  })
})
