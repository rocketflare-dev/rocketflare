/**
 * The one seeded-account list (`ui/lib/dev-accounts.ts`) and the role labels it shows: the
 * quick-login buttons are named from `ROLE_LABELS`, the `?as=` allow-list is exactly the list,
 * and the seed script reads the same constant rather than a copy.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROLE_LABELS, roleLabel } from '@rocketflare/shared/tenants'
import { describe, expect, it } from 'vitest'
import { DEV_ACCOUNTS, devAccountLabel, isDevAccount } from '@/ui/lib/dev-accounts'

describe('DEV_ACCOUNTS', () => {
  it('labels each tenant account by its role label, and the platform account "Global admin"', () => {
    expect(DEV_ACCOUNTS.map(devAccountLabel)).toEqual(['Owner', 'Admin', 'Member', 'Global admin'])
    for (const account of DEV_ACCOUNTS) {
      if (account.role) expect(devAccountLabel(account)).toBe(ROLE_LABELS[account.role])
    }
  })

  it('allows exactly the listed addresses, case-insensitively', () => {
    expect(isDevAccount('OWNER@example.test')).toBe(true)
    expect(isDevAccount('someone@example.test')).toBe(false)
    expect(isDevAccount(null)).toBe(false)
  })

  it('has one owner and is what the seed script reads', () => {
    expect(DEV_ACCOUNTS.filter(a => a.role === 'owner')).toHaveLength(1)
    const seed = readFileSync(resolve(__dirname, '../../scripts/seed.ts'), 'utf8')
    expect(seed).toContain("import { DEV_ACCOUNTS } from '../src/ui/lib/dev-accounts'")
    expect(seed).not.toMatch(/email: 'member@example\.test', name:/)
  })
})

describe('roleLabel', () => {
  it('names every role', () => {
    expect(roleLabel('owner')).toBe('Owner')
    expect(roleLabel('support')).toBe('Support')
  })
})
