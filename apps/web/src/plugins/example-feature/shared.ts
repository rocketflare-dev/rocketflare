/**
 * Constants both halves of the plugin need and neither owns (D31).
 *
 * `EXAMPLE_NOTES_ENTITY` is the one string that has to mean the same thing in three places: the
 * server's `entity.changed` nudge, the UI's query-key family root, and — through
 * `invalidationsFor()` — what `WebSocketProvider` invalidates when that nudge arrives. Writing it
 * once is what makes the kit's convention ("the `entity` of a nudge IS a query-key family root")
 * true by construction rather than by review.
 */

/** The plugin's query-key family root and its `entity.changed` entity. `<id>:<thing>`. */
export const EXAMPLE_NOTES_ENTITY = 'example-feature:notes'
