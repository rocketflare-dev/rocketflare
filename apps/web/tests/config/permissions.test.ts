/**
 * The D10 ability matrix (02 §10b), cell by cell — no database. If `src/permissions/CLAUDE.md`'s
 * table changes, this file changes with it.
 */

import { type Actions, CORE_SUBJECTS, packedRulesSchema, type Role } from '@gmgo/shared/permissions'
import { membershipRoleSchema } from '@gmgo/shared/tenants'
import { describe, expect, it } from 'vitest'
import {
  abilityFromPackedRules,
  applyFeatureFlags,
  buildAbility,
  emptyAbility,
  getEffectiveRole,
  packRules,
  rolePermissions,
  unpackRules,
} from '@/permissions'

const ROLES = membershipRoleSchema.options
const CRUD: Actions[] = ['create', 'read', 'update', 'delete']

/** `create` = create + read, nothing else (member on `File`). */
type Level = 'manage' | 'read' | 'create' | 'none'

/** Subject → per-role level, transcribed from the matrix. */
const MATRIX: Record<string, Record<Role, Level>> = {
  Tenant: { owner: 'manage', admin: 'read', support: 'manage', member: 'read' },
  TenantMember: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  Invitation: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  ApiKey: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  ActivityEvent: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  Notification: { owner: 'manage', admin: 'manage', support: 'manage', member: 'manage' },
  File: { owner: 'manage', admin: 'manage', support: 'manage', member: 'create' },
  AiConfig: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  Prompt: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  Conversation: { owner: 'manage', admin: 'manage', support: 'manage', member: 'manage' },
  AccessRequest: { owner: 'none', admin: 'none', support: 'none', member: 'none' },
  User: { owner: 'none', admin: 'none', support: 'none', member: 'none' },
}

const build = (role: Role | null, features: string[] = [], isGlobalAdmin = false) =>
  buildAbility({ role, isGlobalAdmin, features })

describe('ability matrix (D10)', () => {
  it('covers every core subject except `all`', () => {
    expect(Object.keys(MATRIX).sort()).toEqual(CORE_SUBJECTS.filter(s => s !== 'all').sort())
  })

  for (const role of ROLES) {
    describe(role, () => {
      const ability = build(role)
      for (const [subject, levels] of Object.entries(MATRIX)) {
        const level = levels[role]
        it(`${level} ${subject}`, () => {
          const s = subject as (typeof CORE_SUBJECTS)[number]
          if (level === 'manage') {
            expect(ability.can('manage', s)).toBe(true)
            for (const a of CRUD) expect(ability.can(a, s)).toBe(true)
          } else if (level === 'read') {
            expect(ability.can('read', s)).toBe(true)
            expect(ability.can('manage', s)).toBe(false)
            for (const a of ['create', 'update', 'delete'] as Actions[]) {
              expect(ability.can(a, s)).toBe(false)
            }
          } else if (level === 'create') {
            expect(ability.can('create', s)).toBe(true)
            expect(ability.can('read', s)).toBe(true)
            expect(ability.can('manage', s)).toBe(false)
            for (const a of ['update', 'delete'] as Actions[]) expect(ability.can(a, s)).toBe(false)
          } else {
            for (const a of ['manage', ...CRUD] as Actions[]) expect(ability.can(a, s)).toBe(false)
          }
        })
      }
      it('never has `manage all`', () => {
        expect(ability.can('manage', 'all')).toBe(false)
      })
    })
  }

  it('globalAdmin manages all, including platform subjects and every feature', () => {
    const ability = build(null, [], true)
    expect(ability.can('manage', 'all')).toBe(true)
    for (const s of CORE_SUBJECTS) expect(ability.can('manage', s)).toBe(true)
    expect(ability.can('delete', 'Tenant')).toBe(true)
    expect(ability.can('access', 'Feature:anything')).toBe(true)
    // The flag wins over whatever membership role is present.
    expect(build('member', [], true).can('manage', 'AccessRequest')).toBe(true)
  })

  it('no role → no permissions', () => {
    const ability = build(null)
    expect(ability.rules).toEqual([])
    for (const s of CORE_SUBJECTS) expect(ability.can('read', s)).toBe(false)
    expect(emptyAbility().can('read', 'Tenant')).toBe(false)
  })
})

describe('feature flags (access)', () => {
  it('owner/admin/member only access the injected features', () => {
    for (const role of ['owner', 'admin', 'member'] as Role[]) {
      const ability = build(role, ['analytics'])
      expect(ability.can('access', 'Feature:analytics')).toBe(true)
      expect(ability.can('access', 'Feature:ai')).toBe(false)
      expect(build(role).can('access', 'Feature:analytics')).toBe(false)
    }
  })

  it('support accesses every feature', () => {
    const ability = build('support')
    expect(ability.can('access', 'Feature:analytics')).toBe(true)
    expect(ability.can('access', 'Feature:ai')).toBe(true)
  })

  it('features never grant anything but `access`', () => {
    const ability = build('member', ['Tenant', 'all'])
    expect(ability.can('manage', 'Tenant')).toBe(false)
    expect(ability.can('manage', 'all')).toBe(false)
    expect(ability.can('access', 'Feature:Tenant')).toBe(true)
  })

  it('applyFeatureFlags is exported for custom builders', () => {
    const calls: unknown[][] = []
    applyFeatureFlags(((...args: unknown[]) => calls.push(args)) as never, ['a', 'b'])
    expect(calls).toEqual([
      ['access', 'Feature:a'],
      ['access', 'Feature:b'],
    ])
  })
})

describe('getEffectiveRole', () => {
  it('prefers the global-admin flag, then the membership role', () => {
    expect(getEffectiveRole({ isGlobalAdmin: true, tenantUser: { role: 'member' } })).toBe(
      'globalAdmin'
    )
    expect(getEffectiveRole({ isGlobalAdmin: false, tenantUser: { role: 'admin' } })).toBe('admin')
    expect(getEffectiveRole({ role: 'support' })).toBe('support')
    expect(getEffectiveRole({ isGlobalAdmin: false, tenantUser: null })).toBeNull()
  })

  it('rolePermissions has exactly one handler per effective role', () => {
    expect(Object.keys(rolePermissions).sort()).toEqual([...ROLES, 'globalAdmin'].sort())
  })
})

describe('pack / unpack round-trip (D13)', () => {
  for (const role of ROLES) {
    it(`${role} survives the wire`, () => {
      const original = build(role, ['analytics'])
      const packed = packRules(original)
      // What /auth/session sends is what the UI validates.
      const parsed = packedRulesSchema.parse(JSON.parse(JSON.stringify(packed)))
      const restored = abilityFromPackedRules(parsed)
      for (const s of CORE_SUBJECTS) {
        for (const a of ['manage', 'read', 'create', 'update', 'delete'] as Actions[]) {
          expect(restored.can(a, s), `${role} ${a} ${s}`).toBe(original.can(a, s))
        }
      }
      expect(restored.can('access', 'Feature:analytics')).toBe(true)
      expect(restored.can('access', 'Feature:other')).toBe(original.can('access', 'Feature:other'))
      // unpackRules normalises (arrays for action/subject, `inverted: false`); compare the shape.
      const arr = (v: unknown) => (Array.isArray(v) ? v : [v])
      const shape = (rules: { action: unknown; subject?: unknown }[]) =>
        rules.map(r => ({ action: arr(r.action), subject: arr(r.subject) }))
      expect(shape(unpackRules(parsed))).toEqual(shape(original.rules))
    })
  }

  it('globalAdmin `manage all` survives packing', () => {
    const restored = abilityFromPackedRules(packRules(build(null, [], true)))
    expect(restored.can('manage', 'all')).toBe(true)
    expect(restored.can('delete', 'User')).toBe(true)
  })
})
