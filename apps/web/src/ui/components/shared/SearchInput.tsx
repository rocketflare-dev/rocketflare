import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useCallback, useEffect, useRef, useState } from 'react'

interface SearchInputProps {
  value: string
  /** Debounced */
  onChange: (value: string) => void
  placeholder?: string
  debounceMs?: number
  className?: string
  size?: 'sm' | 'md'
  'aria-label'?: string
}

/** Debounced search box with a clear button, for server-side search on index pages. */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  debounceMs = 300,
  className = '',
  size = 'md',
  'aria-label': ariaLabel = 'Search',
}: SearchInputProps) {
  const [localValue, setLocalValue] = useState(value)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setLocalValue(value)
  }, [value])

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  const handleChange = useCallback(
    (next: string) => {
      setLocalValue(next)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => onChange(next), debounceMs)
    },
    [onChange, debounceMs]
  )

  const handleClear = useCallback(() => {
    setLocalValue('')
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    onChange('')
  }, [onChange])

  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'

  return (
    <div className={`relative ${className}`}>
      <MagnifyingGlassIcon
        className={`pointer-events-none absolute left-3 top-1/2 ${iconSize} -translate-y-1/2 text-muted`}
      />
      <input
        type="search"
        className={`input w-full pl-10 pr-10 ${size === 'sm' ? 'input-sm' : ''}`}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={localValue}
        onChange={e => handleChange(e.target.value)}
      />
      {localValue && (
        <button
          type="button"
          className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted hover:text-base-content"
          onClick={handleClear}
          aria-label="Clear search"
        >
          <XMarkIcon className={iconSize} />
        </button>
      )}
    </div>
  )
}
