/**
 * The kit's own name, for tests asserting it never leaks into what an app shows its users (MCP
 * server info, tool output, the settings page). Spelled in two halves on purpose: the rename
 * rewrites the whole word to the app's slug, and a test that then asserted the app's OWN name
 * never appears would fail for an app called `acme` whose fixtures say "Acme Tools".
 */
export const KIT_NAME = new RegExp(['rocket', 'flare'].join(''), 'i')
