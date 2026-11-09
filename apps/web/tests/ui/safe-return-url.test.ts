/** `safeReturnUrl` applies the server's same-origin path rule. */
import { describe, expect, it } from 'vitest'
import { safeReturnUrl } from '@/ui/lib/navigation'

describe('safeReturnUrl', () => {
  it.each([
    '/\t/other.example/x',
    '/\n/other.example/x',
    '/a\\b',
    '//other.example/x',
    'https://other.example/',
  ])('%j falls back', value => {
    expect(safeReturnUrl(value, '/home')).toBe('/home')
  })

  it('keeps a same-origin path', () => {
    expect(safeReturnUrl('/settings?tab=people')).toBe('/settings?tab=people')
  })
})
