/**
 * The pure half of the kit update check (`scripts/kit-update-check.mjs`, a Claude Code
 * `SessionStart` hook): should this session check, is the cached answer fresh, which release is
 * newest, what changed between the copy's version and it, and the one message Claude is handed.
 * No I/O here — the script owns git, the network, the cache file and stdout — so every decision is
 * a unit test (`apps/web/tests/config/update-check-lib.test.ts`).
 */
import { compareVersions, VERSION_RE } from './upgrade-lib.mjs'

/** How long a cached "newest release" answer is trusted: one network call a day, at most. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How long a FAILED check (offline, remote unreachable) is remembered before retrying. Without it
 * an offline laptop would pay the network timeout on every session start.
 */
export const FAILURE_TTL_MS = 60 * 60 * 1000

/** Opt-out: `ROCKETFLARE_UPDATE_CHECK=0|false|off|no`. */
export const OPT_OUT_ENV = 'ROCKETFLARE_UPDATE_CHECK'

/** Releases summarised in the message; anything older is counted, not listed. */
export const MAX_LISTED = 3

/**
 * Why this session skips the check, or null to go ahead.
 *
 * - Only a fresh `startup`: `resume`, `clear` and `compact` are the same person in the same sitting,
 *   and "once per session" means they were already told.
 * - Only a COPY: the kit itself (`app` null) is by definition on its own newest release.
 * - Never in CI, and never when opted out.
 */
export function skipReason({ source, manifest, env }) {
  const optOut = String(env[OPT_OUT_ENV] ?? '')
    .trim()
    .toLowerCase()
  if (['0', 'false', 'off', 'no'].includes(optOut)) return `${OPT_OUT_ENV}=${optOut}`
  if (env.CI) return 'CI'
  if (source && source !== 'startup') return `session ${source}`
  if (!manifest) return 'no .rocketflare.json'
  if (manifest.app == null) return 'this is the kit itself'
  if (!manifest.kit?.repo) return 'no kit.repo in .rocketflare.json'
  if (!VERSION_RE.test(manifest.kit?.version ?? '')) return 'no kit.version in .rocketflare.json'
  return null
}

/**
 * The cached answer, when it is for this repo AND this copy's version (an upgrade changes which
 * releases are news) and younger than the TTL.
 */
export function freshCache(cache, { repo, current, now }) {
  if (!cache || cache.repo !== repo || cache.current !== current) return null
  if (typeof cache.checkedAt !== 'number') return null
  const ttl = cache.failed ? FAILURE_TTL_MS : CACHE_TTL_MS
  if (now - cache.checkedAt < 0 || now - cache.checkedAt >= ttl) return null
  return cache
}

/** The newest `X.Y.Z` among `git ls-remote --tags --refs` lines (or bare tag names). */
export function latestVersion(lines) {
  let best = null
  for (const line of lines) {
    const tag =
      line
        .trim()
        .split(/\s+/)
        .pop()
        ?.replace(/^refs\/tags\//, '') ?? ''
    if (!VERSION_RE.test(tag)) continue
    if (best === null || compareVersions(tag, best) > 0) best = tag
  }
  return best
}

/**
 * `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<file>` for a GitHub remote (https or
 * ssh), else null — a kit hosted elsewhere simply gets a message with no summaries.
 */
export function rawFileUrl(repo, ref, file) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo)
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${ref}/${file}` : null
}

/**
 * The first paragraph of every `## X.Y.Z` section in the kit's `CHANGELOG.md` with
 * `from < X.Y.Z <= to`, newest first — which is the note's standalone summary sentence, the one
 * `scripts/release.mjs` lifts verbatim. The trailing `[Porting note](…)` line is dropped.
 */
export function changelogSummaries(text, from, to) {
  const out = []
  const sections = text.split(/^## /m).slice(1)
  for (const section of sections) {
    const version = /^(\d+\.\d+\.\d+)/.exec(section)?.[1]
    if (!version) continue
    if (compareVersions(version, from) <= 0 || compareVersions(version, to) > 0) continue
    const body = section.split('\n').slice(1).join('\n').trim()
    const summary = (body.split(/\n\s*\n/)[0] ?? '')
      .split('\n')
      .filter(line => !/^\[Porting note\]/.test(line.trim()))
      .join(' ')
      .trim()
    out.push({ version, summary })
  }
  return out.sort((a, b) => compareVersions(b.version, a.version))
}

/**
 * What Claude is handed as `additionalContext`, or null when the copy is current. Written as an
 * instruction because it is one: say it once, briefly, and do nothing about it unless asked.
 */
export function updateMessage({ current, latest, summaries }) {
  if (!latest || compareVersions(latest, current) <= 0) return null
  const listed = summaries.slice(0, MAX_LISTED)
  const lines = [
    `Rocketflare kit update available: ${latest} (this app is on ${current}).`,
    ...listed.map(s => `- ${s.version}: ${s.summary}`),
  ]
  const unlisted = summaries.length - listed.length
  if (unlisted > 0) lines.push(`- …and ${unlisted} earlier release(s).`)
  lines.push(
    'Tell the user this ONCE, in one or two sentences, at the start of your first reply — then carry on with what they asked. Suggest `/rf-upgrade` to see what applies to this app (it plans before it changes anything). Do not start an upgrade unless they ask. To silence this check: ROCKETFLARE_UPDATE_CHECK=0.'
  )
  return lines.join('\n')
}
