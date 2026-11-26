/**
 * A `.data-table` that becomes a list below `sm`: the head goes, each row is a wrapping line of
 * its cells (the title cell takes the whole first line), and the cells marked `STACK_HIDE` drop
 * out. ONE set of DOM nodes for both widths — never a second, phone-only copy of every row, which
 * would double every link and every live status for a screen reader. Utilities sit in a later
 * cascade layer than `.data-table`, so these win at the small width and do nothing above it.
 */
export const STACK_TABLE = 'max-sm:block'
export const STACK_HEAD = 'max-sm:hidden'
export const STACK_BODY = 'max-sm:block'
export const STACK_ROW =
  'max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-1.5 ' +
  'max-sm:px-5 max-sm:py-3 max-sm:border-b max-sm:border-[color:var(--border-subtle)] ' +
  'max-sm:last:border-b-0'
/** Every cell: no fixed height, padding or rule of its own once it is part of a line. */
export const STACK_CELL = 'max-sm:h-auto! max-sm:p-0! max-sm:border-0!'
/** The cell that leads the row — the first line on its own. */
export const STACK_LEAD = `${STACK_CELL} max-sm:w-full`
/** A column the stacked row leaves out (still in the page above `sm`). */
export const STACK_HIDE = 'max-sm:hidden!'
/** A cell pushed to the end of its line (a row's actions). */
export const STACK_END = `${STACK_CELL} max-sm:ml-auto`
