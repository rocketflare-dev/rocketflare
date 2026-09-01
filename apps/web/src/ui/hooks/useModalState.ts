import { useCallback, useState } from 'react'

/**
 * Several named modals in one object instead of N `useState`s.
 *
 * ```tsx
 * const modals = useModalState({ edit: false, remove: false })
 * modals.open('edit'); modals.close('edit'); modals.isOpen('edit'); modals.closeAll()
 * ```
 */
export function useModalState<T extends Record<string, boolean>>(initialState: T) {
  const [state, setState] = useState<T>(initialState)

  const open = useCallback(<K extends keyof T>(key: K) => {
    setState(prev => ({ ...prev, [key]: true }))
  }, [])

  const close = useCallback(<K extends keyof T>(key: K) => {
    setState(prev => ({ ...prev, [key]: false }))
  }, [])

  const toggle = useCallback(<K extends keyof T>(key: K) => {
    setState(prev => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const isOpen = useCallback(<K extends keyof T>(key: K): boolean => state[key], [state])

  const closeAll = useCallback(() => {
    setState(prev => {
      const next = { ...prev }
      for (const key of Object.keys(next) as (keyof T)[]) next[key] = false as T[keyof T]
      return next
    })
  }, [])

  return { state, open, close, toggle, isOpen, closeAll }
}

/**
 * One modal that carries the item it acts on (edit/delete dialogs).
 *
 * ```tsx
 * const editModal = useModalWithData<User>()
 * editModal.openWith(user)
 * {editModal.isOpen && editModal.data && <EditModal user={editModal.data} onClose={editModal.close} />}
 * ```
 */
export function useModalWithData<T>() {
  const [isOpen, setIsOpen] = useState(false)
  const [data, setData] = useState<T | null>(null)

  const openWith = useCallback((item: T) => {
    setData(item)
    setIsOpen(true)
  }, [])

  const open = useCallback(() => setIsOpen(true), [])

  const close = useCallback(() => {
    setIsOpen(false)
    // Keep the data through the exit animation
    setTimeout(() => setData(null), 200)
  }, [])

  return { isOpen, data, openWith, open, close }
}
