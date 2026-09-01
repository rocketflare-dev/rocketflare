/**
 * CASL on the client (D10). The server packs the active tenant's rules into `/auth/session`
 * (`permissions`, `packRules`); this unpacks them into a typed `AppAbility`. Only the wire
 * format and `@casl/ability` are used here — the role → grant MATRIX lives in `src/permissions`
 * (server code) and is never imported by the UI.
 */
import { createMongoAbility } from '@casl/ability'
import { unpackRules } from '@casl/ability/extra'
import { createContextualCan } from '@casl/react'
import type { AppAbility, PackedRule, PackedRules } from '@rocketflare/shared/permissions'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { useAuth } from '@/ui/hooks/useAuth'

export type { AppAbility }

/** Rebuild an ability from the session's packed rules. Exported for tests and non-React code. */
export function abilityFromPackedRules(rules: PackedRules): AppAbility {
  return createMongoAbility<AppAbility>(unpackRules(rules as PackedRule[]))
}

/** An ability with no rules — what a logged-out reader carries. */
export function emptyAbility(): AppAbility {
  return createMongoAbility<AppAbility>([])
}

/** Defaults to an ability that permits nothing, so a stray render outside the provider hides. */
export const AbilityContext = createContext<AppAbility>(emptyAbility())

/** `<Can I="manage" a="Tenant">…</Can>` — CASL React's contextual component. */
export const Can = createContextualCan(AbilityContext.Consumer)

export function useAbility(): AppAbility {
  return useContext(AbilityContext)
}

/** Derives the ability from `useAuth().session.permissions`; memoised on the rules array. */
export function AbilityProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const rules = session?.permissions
  const ability = useMemo(() => (rules ? abilityFromPackedRules(rules) : emptyAbility()), [rules])
  return <AbilityContext.Provider value={ability}>{children}</AbilityContext.Provider>
}
