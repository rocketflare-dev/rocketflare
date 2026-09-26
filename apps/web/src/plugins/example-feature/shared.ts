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

/**
 * The `signState` purpose of the ping link (D34). Part of the signed body, so a token minted for
 * this flow can never be replayed into another one — which is why it names the plugin AND the flow.
 */
export const EXAMPLE_PING_LINK_PURPOSE = 'example-feature:ping-link'

/** How long a ping link stays valid. Short: it is a capability, and anybody holding it may use it. */
export const EXAMPLE_PING_LINK_TTL_SECONDS = 600
