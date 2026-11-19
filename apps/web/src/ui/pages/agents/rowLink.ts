/**
 * A whole table row as a link, without giving up a real `<a>`: the row's main link stretches an
 * invisible overlay over the row (`ROW_LINK`), so a click anywhere opens it, middle-click and
 * open-in-new-tab still work, and keyboard focus stays on ONE link per row. Anything else
 * interactive in the row (a button, a second link) is lifted above the overlay with `ABOVE_ROW`.
 * `position: relative` on a `<tr>` is what anchors the overlay; every current engine supports it.
 */
export const LINK_ROW = 'relative cursor-pointer hover:bg-base-200/60'
export const ROW_LINK =
  "after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-primary"
export const ABOVE_ROW = 'relative z-10'
