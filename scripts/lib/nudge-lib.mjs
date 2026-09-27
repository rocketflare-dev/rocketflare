/**
 * The pure half of the Claude Code nudge hooks (`changelog-nudge.mjs`, `release-site-nudge.mjs`).
 *
 * **No imports, on purpose.** The plugins repository carries a copy of this file and of
 * `release-site-nudge.mjs` — its `scripts/` is a thin, older copy of the kit's — so everything
 * here must stand alone rather than reach into `plugin-lib.mjs` or `upgrade-lib.mjs`.
 *
 * One fact every hook here depends on: a `PreToolUse` hook's plain stdout goes to the debug log,
 * NOT to Claude. Only `hookSpecificOutput.additionalContext` reaches the model, and `systemMessage`
 * shows in the transcript. `hookJson` is the one place that shape is written.
 */

/** `true` when a Bash command runs `git commit`. */
export function isGitCommit(command) {
  return typeof command === 'string' && /\bgit\s+commit\b/.test(command)
}

/** `true` for `git commit -a` / `-am …` — tracked changes are staged by the commit itself. */
export function commitsAll(command) {
  return typeof command === 'string' && /\bcommit\b[^|;&]*\s-[a-zA-Z]*a/.test(command)
}

/** The `version` of a `package.json` text, or `null` for anything unreadable. */
export function versionOf(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  try {
    const version = JSON.parse(text)?.version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/** `{ from, to }` when the version differs between the two texts, else `null`. */
export function versionChange(before, after) {
  const to = versionOf(after)
  if (!to) return null
  const from = versionOf(before)
  return from === to ? null : { from, to }
}

/**
 * What to tell Claude when a release commit is on its way. `kind` is `kit` or `plugins`; the site
 * steps differ only in what else a plugins release touches.
 */
export function siteReminder({ from, to, kind, wwwDir }) {
  const where = wwwDir ?? '~/work/rocketflare-www (or $ROCKETFLARE_WWW_DIR)'
  const what = kind === 'plugins' ? 'rocketflare-plugins' : 'the Rocketflare kit'
  return [
    `This commit moves ${what} from ${from ?? '(none)'} to ${to} in package.json — a release.`,
    'After the tag is pushed and the GitHub Release exists, update the website, rocketflare.dev:',
    `  1. In ${where}, create a branch (e.g. release-${to}).`,
    '  2. Run `npm run sync:releases` and write the release summary in PLAIN TEXT (no backticks —',
    '     the changelog renders summaries unformatted).',
    kind === 'plugins'
      ? '  3. Update src/data/plugins.ts (every plugin version, the @<tag> install commands, any new plugin), then run `npm run sync:plugins` to refresh the per-plugin pages from each README.'
      : '  3. A new capability also gets site content, not only a changelog line (concepts page, landing item, compare row).',
    '  4. Run `npm run check:releases && npm run build`, then open a PR; merging deploys the site.',
    'Say so if this release deliberately needs no site change.',
  ].join('\n')
}

/** The hook's stdout: context for Claude, plus a one-line notice in the transcript. */
export function hookJson(message, notice) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message },
    systemMessage: notice ?? message.split('\n')[0],
  })
}
