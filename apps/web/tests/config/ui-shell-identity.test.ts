import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPageIdentity } from '../../../../scripts/lib/page-identity.mjs'

describe('the UI shell takes its identity from the build', () => {
  const html = readFileSync(resolve(__dirname, '../../src/ui/index.html'), 'utf8')

  it('has a <title> and a description the build can fill', () => {
    const built = applyPageIdentity(html, {
      title: 'Built Title',
      description: 'Built description.',
    })
    expect(built).toContain('>Built Title</title>')
    expect(built).toContain('content="Built description."')
  })
})
