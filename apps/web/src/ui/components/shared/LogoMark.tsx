/**
 * The app mark, inline so it takes its colour from the theme (`text-primary` by default).
 * Neutral placeholder geometry — replace the `<path>` (and public/favicon.svg) to rebrand.
 */
export function LogoMark({ className = 'w-7 h-7' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={`text-primary flex-none ${className}`}
      fill="currentColor"
      role="img"
      aria-hidden="true"
    >
      <rect
        x="4"
        y="4"
        width="56"
        height="56"
        rx="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
      />
      <path d="M18 44V20h8l6 12 6-12h8v24h-7V31l-7 13-7-13v13z" />
    </svg>
  )
}
