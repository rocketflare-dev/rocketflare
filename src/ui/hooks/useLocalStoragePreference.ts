import { useCallback, useEffect, useState } from 'react'

/**
 * A per-user UI preference persisted in localStorage (collapsed nav, table density…).
 * Server-derived state never belongs here — that is the query cache's job.
 */
export function useLocalStoragePreference<T>(
  key: string,
  defaultValue: T,
  serialize: (value: T) => string = String as unknown as (value: T) => string,
  deserialize: (value: string) => T = ((v: string) => v as unknown as T) as (value: string) => T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key)
      return saved === null ? defaultValue : deserialize(saved)
    } catch {
      return defaultValue
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, serialize(value))
    } catch {
      // Quota exceeded / privacy mode — the in-memory value still works
    }
  }, [key, value, serialize])

  return [value, setValue]
}

/** `'true'`/`'false'` string round-trip. */
export function useBooleanPreference(
  key: string,
  defaultValue: boolean
): [boolean, (value: boolean | ((prev: boolean) => boolean)) => void] {
  const serialize = useCallback((v: boolean) => String(v), [])
  const deserialize = useCallback((v: string) => v === 'true', [])
  return useLocalStoragePreference<boolean>(key, defaultValue, serialize, deserialize)
}

/** Type-safe string-enum preference. */
export function useStringPreference<T extends string>(
  key: string,
  defaultValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const serialize = useCallback((v: T) => v, [])
  const deserialize = useCallback((v: string) => v as T, [])
  return useLocalStoragePreference<T>(key, defaultValue, serialize, deserialize)
}

/** Several related settings as one JSON object. */
export function useStoredSettings<T extends Record<string, unknown>>(
  key: string,
  defaultValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  return useLocalStoragePreference<T>(key, defaultValue, JSON.stringify, JSON.parse)
}
