/**
 * The two content-security policies (`config` project, no database). Every response gets
 * `frame-ancestors 'none'` except ONE class a route opts into — a PDF byte stream from
 * `/api/files/:id`, which the document viewer frames. The risk in a second policy is that it
 * drifts: somebody tightens `script-src` in the default one and the relaxed one quietly keeps the
 * old rule, on the only responses where framing is allowed. Both are built from one `CSP_BASE`,
 * and this is the test that says so — they must differ in `frame-ancestors` and in nothing else.
 */

import { EMBEDDABLE_MIME_TYPES, INLINE_MIME_TYPES } from '@rocketflare/shared/files'
import { describe, expect, it } from 'vitest'
import {
  CONTENT_SECURITY_POLICY,
  EMBEDDABLE_CONTENT_SECURITY_POLICY,
} from '@/api/middleware/security-headers'

const directives = (policy: string) => policy.split('; ').map(d => d.trim())

describe('content security policies', () => {
  it('differ in exactly the frame-ancestors directive', () => {
    const strict = directives(CONTENT_SECURITY_POLICY)
    const embeddable = directives(EMBEDDABLE_CONTENT_SECURITY_POLICY)
    expect(strict).toContain("frame-ancestors 'none'")
    expect(embeddable).toContain("frame-ancestors 'self'")
    expect(strict.filter(d => !d.startsWith('frame-ancestors'))).toEqual(
      embeddable.filter(d => !d.startsWith('frame-ancestors'))
    )
    // Exactly one of each, so neither policy can be read two ways.
    expect(strict.filter(d => d.startsWith('frame-ancestors'))).toHaveLength(1)
    expect(embeddable.filter(d => d.startsWith('frame-ancestors'))).toHaveLength(1)
  })
})

describe('inline vs embeddable media types', () => {
  it('are separate lists, and everything framable is also inline', () => {
    // The direction that matters: a type may render in place without being framable (an avatar),
    // but a framable type that downloads would be unreachable.
    for (const type of EMBEDDABLE_MIME_TYPES) {
      expect(INLINE_MIME_TYPES as readonly string[]).toContain(type)
    }
    // And the lists are not the same object — an app adding an inline type must not widen framing.
    expect(EMBEDDABLE_MIME_TYPES.length).toBeLessThan(INLINE_MIME_TYPES.length)
    expect(EMBEDDABLE_MIME_TYPES).toEqual(['application/pdf'])
  })
})
