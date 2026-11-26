/**
 * A row of overlapping faces: the first few people, then "+N". A photo that fails to load falls
 * back to initials (the object is tenant-scoped, the URL is not). The stack is ONE image to a
 * screen reader, named with the people it shows.
 */
import { useState } from 'react'
import { initials } from '@/ui/lib/format'

export interface AvatarPerson {
  id: string
  name: string
  avatarUrl?: string | null
}

export interface AvatarStackProps {
  people: readonly AvatarPerson[]
  /** Everyone there is, when more than `people` — drives the "+N". */
  total?: number
  max?: number
  className?: string
}

/** "Olivia Bennett, Marcus Adeyemi and 4 others". */
export function avatarStackLabel(names: readonly string[], total: number): string {
  const others = total - names.length
  if (names.length === 0) return total === 1 ? '1 person' : `${total} people`
  if (others <= 0) {
    return names.length === 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  }
  return `${names.join(', ')} and ${others} ${others === 1 ? 'other' : 'others'}`
}

const SIZES = { sm: 'w-7 h-7', md: 'w-9 h-9' } as const

/** One face: the photo, or the initials when there is none or it fails to load. Decorative. */
export function Avatar({
  person,
  size = 'md',
}: {
  person: AvatarPerson
  size?: keyof typeof SIZES
}) {
  return <Face person={person} size={size} />
}

function Face({ person, size = 'md' }: { person: AvatarPerson; size?: keyof typeof SIZES }) {
  const [broken, setBroken] = useState(false)
  const base = `${SIZES[size]} rounded-full ring-2 ring-[color:var(--surface-panel)] shrink-0 overflow-hidden`
  if (person.avatarUrl && !broken) {
    return (
      <img
        src={person.avatarUrl}
        alt=""
        className={`${base} object-cover`}
        onError={() => setBroken(true)}
      />
    )
  }
  return (
    <span
      aria-hidden
      className={`${base} inline-flex items-center justify-center text-xs font-semibold leading-none tracking-tight bg-[color:var(--surface-active)] text-[color:var(--text-primary)]`}
    >
      {initials(person.name)}
    </span>
  )
}

export function AvatarStack({ people, total, max = 5, className = '' }: AvatarStackProps) {
  const shown = people.slice(0, max)
  const count = Math.max(total ?? people.length, people.length)
  const more = count - shown.length
  return (
    <div
      role="img"
      aria-label={avatarStackLabel(
        shown.map(p => p.name),
        count
      )}
      className={`flex items-center -space-x-1.5 ${className}`}
    >
      {shown.map(p => (
        <Face key={p.id} person={p} />
      ))}
      {more > 0 && (
        <span className="w-9 h-9 rounded-full ring-2 ring-[color:var(--surface-panel)] inline-flex items-center justify-center text-xs font-medium bg-[color:var(--surface-inset)] text-secondary tabular-nums">
          +{more}
        </span>
      )}
    </div>
  )
}
