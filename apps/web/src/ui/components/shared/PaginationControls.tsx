import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import type { PaginationMeta } from '@rocketflare/shared/pagination'

interface PaginationControlsProps {
  /** `pagination` from a `paginatedResponse()` body */
  pagination: PaginationMeta
  /** 1-based */
  onPageChange: (page: number) => void
  isLoading?: boolean
  className?: string
}

/** "Showing X to Y of Z" + Previous/Next. Renders nothing for a single page. */
export function PaginationControls({
  pagination,
  onPageChange,
  isLoading = false,
  className = '',
}: PaginationControlsProps) {
  const { page, pageSize, total, totalPages } = pagination
  if (total === 0 || totalPages <= 1) return null

  const startItem = (page - 1) * pageSize + 1
  const endItem = Math.min(page * pageSize, total)

  return (
    <nav
      aria-label="Pagination"
      className={`flex items-center justify-between gap-3 border-t border-[color:var(--border-subtle)] pt-4 ${className}`}
    >
      {/* On a phone the range is the short form and the buttons are icons, so nothing wraps. */}
      <div className="text-sm text-secondary tabular-nums whitespace-nowrap">
        <span className="hidden sm:inline">Showing </span>
        <span className="font-medium">{startItem}</span>
        <span className="hidden sm:inline"> to </span>
        <span className="sm:hidden">–</span>
        <span className="font-medium">{endItem}</span> of{' '}
        <span className="font-medium">{total.toLocaleString()}</span>
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        <button
          type="button"
          className="btn btn-sm btn-ghost gap-1 max-sm:btn-square"
          aria-label="Previous"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1 || isLoading}
        >
          <ChevronLeftIcon className="h-4 w-4" />
          <span className="hidden sm:inline">Previous</span>
        </button>
        <span className="text-sm text-secondary px-1 sm:px-2 tabular-nums whitespace-nowrap">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost gap-1 max-sm:btn-square"
          aria-label="Next"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages || isLoading}
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>
    </nav>
  )
}
