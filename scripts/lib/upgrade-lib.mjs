/**
 * The pure half of `scripts/upgrade.mjs`: path classification against `.rocketflare.json`, the
 * diff translator, and the release-note parser. No I/O and nothing runs at import time, so
 * `apps/web/tests/config/upgrade-lib.test.ts` can drive it under vitest; `upgrade-lib.d.mts`
 * beside this file is the hand-written type surface (no `allowJs`).
 *
 * The problem this solves: an adopted copy of the kit has been renamed (`scripts/rename.mjs`
 * rewrote `@rocketflare/` to `@myapp/` in every file) and pruned (`docs/ADAPTING.md` §2 told the
 * adopter to delete the example agents, cubes and CLI commands). A raw kit diff therefore matches
 * nothing and, worse, would recreate what they deleted. So before anything is applied:
 *
 *   1. every file block of the diff is classified — the manifest says which surface a path belongs
 *      to, and a surface whose ANCHOR FILE is absent locally is dropped entirely;
 *   2. the surviving blocks are translated through the SAME token map the rename used, so the
 *      patch arrives already speaking the adopter's names.
 *
 * Two invariants make (2) safe and are asserted by the test:
 *
 *   - every replacement is single-line, so `@@ -a,b +c,d @@` line counts are untouched (columns
 *     move, lines do not). `deriveNames` refusing a newline in the display name is what holds it.
 *   - `index <sha>..<sha>` lines are STRIPPED. They name kit blobs that describe nothing once the
 *     content is translated, and their absence makes `git apply --3way` fail loudly rather than
 *     silently merge against the wrong preimage.
 */
import { applyReplacements, isExcluded } from './rename-lib.mjs'

// ---------------------------------------------------------------- globs

/**
 * `*` stops at a `/`, `**\/` spans directories, `**` spans anything. Deliberately tiny — the
 * manifest's globs are hand-written and this is the only thing that reads them.
 */
export function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:[^/]+/)*'
        } else out += '.*'
      } else out += '[^/]*'
    } else if ('.+^${}()|[]\\?'.includes(c)) out += `\\${c}`
    else out += c
  }
  return new RegExp(`^${out}$`)
}

/** True when `relPath` matches any glob in `globs`. */
export function matchesAny(relPath, globs) {
  return globs.some(g => globToRegExp(g).test(relPath))
}

// ---------------------------------------------------------------- manifest

/** `app === null` means this checkout IS the kit, not a copy of it. */
export function isKitManifest(manifest) {
  return manifest != null && manifest.app == null
}

/**
 * Every surface whose anchor file is missing from `presentPaths`. These are the parts the adopter
 * deleted on purpose; nothing belonging to them may ever be recreated.
 */
export function absentSurfaces(manifest, presentPaths) {
  const present = new Set(presentPaths)
  return manifest.surfaces.filter(s => !present.has(s.anchor)).map(s => s.id)
}

/**
 * Is a checkout something that can be deployed at all?
 *
 * The kit's own repository has no Cloudflare or Neon resources — its tomls keep `<PLACEHOLDER>`
 * ids on purpose, so that a COPY cannot deploy without provisioning first. Running the deploy jobs
 * there fails every time the kit is tagged, which is noise; and a permanently red deploy is one
 * nobody reads, so a genuine failure would hide in it.
 *
 * Not deployable only when BOTH hold: this is the kit (`app === null`) AND it is unprovisioned (a
 * placeholder remains in a toml). Every other case deploys, because the cost of a false "skip" is
 * somebody's production release quietly not happening:
 *
 *   - no manifest at all → deploy (an unknown state is not a licence to skip)
 *   - an `app` block → somebody's product → deploy whatever the tomls say, and let the parity
 *     check fail loudly if they never provisioned
 *   - the kit with provisioned tomls → somebody pointed a kit-shaped repo at real resources → deploy
 *
 * `tomls` is `{ path: text }`, so this stays pure.
 */
export function isDeployable(manifest, tomls) {
  if (manifest == null)
    return { deployable: true, reason: 'no .rocketflare.json — treating this as an app' }
  if (!isKitManifest(manifest)) return { deployable: true, reason: 'this is an app, not the kit' }
  const unprovisioned = Object.entries(tomls)
    .filter(([, text]) => PLACEHOLDER_RE.test(text))
    .map(([file]) => file)
  if (unprovisioned.length === 0) return { deployable: true, reason: 'the kit, but provisioned' }
  return {
    deployable: false,
    reason: `the kit itself, with placeholders still in ${unprovisioned.join(' and ')} — there is nothing provisioned to deploy`,
  }
}

/** The shape `scripts/provision/patch-toml.ts` fills in: `<KV_FOO_ID>`. */
export const PLACEHOLDER_RE = /<[A-Z0-9_]+>/

// ---------------------------------------------------------------- classification

/** The closed set of classes a path can take. */
export const CLASSES = Object.freeze([
  'added',
  'added-collides',
  'modified',
  'deleted',
  'skipped-surface-absent',
  'skipped-locally-deleted',
  'skipped-kit-only',
  'migration-derived',
  'manual-toml',
  'manual-env',
  'manual',
  'binary',
  'verbatim',
])

const TOML_PATHS = ['apps/web/wrangler.toml', 'apps/web/wrangler.staging.toml']
const ENV_PATHS = ['apps/web/.dev.vars.example', 'apps/web/.env.test']

/**
 * What should happen to one path of a kit diff in this adopted tree.
 *
 * `change` is what the kit did (`added` | `modified` | `deleted` | `binary`); `existsLocally` is
 * whether the adopter still has the file. Order matters: a surface the adopter deleted wins over
 * everything, because recreating it is the one outcome that breaks their app.
 *
 * `translate` says whether the file BODY goes through the token map. Paths always do.
 */
export function classifyPath(relPath, ctx) {
  const {
    manifest,
    absent = [],
    existsLocally = false,
    change = 'modified',
    includeKitTooling = false,
  } = ctx
  const surface = manifest.surfaces.find(s => matchesAny(relPath, s.paths))

  if (surface && absent.includes(surface.id)) {
    return {
      class: 'skipped-surface-absent',
      translate: false,
      reason: `surface ${surface.id} is not in this app`,
      surface: surface.id,
    }
  }
  if (relPath.startsWith('apps/web/migrations/')) {
    return {
      class: 'migration-derived',
      translate: false,
      reason: 'port the schema and run `pnpm db:generate`; never copy a migration',
    }
  }
  if (TOML_PATHS.includes(relPath)) {
    return {
      class: 'manual-toml',
      translate: false,
      reason: 'carries your Hyperdrive/KV ids and routes',
    }
  }
  if (ENV_PATHS.includes(relPath)) {
    return { class: 'manual-env', translate: false, reason: 'carries your local database naming' }
  }
  if (matchesAny(relPath, manifest.neverPort)) {
    if (includeKitTooling && isExcluded(relPath)) {
      return {
        class: 'verbatim',
        translate: false,
        reason: 'kit tooling, ported untranslated on request',
      }
    }
    return {
      class: 'skipped-kit-only',
      translate: false,
      reason: 'belongs to the kit, not to your app',
    }
  }
  // A file the RENAME refuses to touch is untranslated in this tree, so its body must stay in the
  // kit's names here too — translating it would guarantee a conflict against its own context. The
  // release notes under `docs/upgrades/` are the case that matters: an app accumulates them as a
  // record of what it has absorbed, still describing the kit.
  const translate = !isExcluded(relPath)
  if (matchesAny(relPath, manifest.manual)) {
    return {
      class: 'manual',
      translate,
      reason: 'yours to decide — read the diff, apply what you want',
    }
  }
  if (change === 'binary') {
    return { class: 'binary', translate: false, reason: 'binary — copy it by hand if you want it' }
  }
  if (change === 'added') {
    return existsLocally
      ? { class: 'added-collides', translate, reason: 'the kit added a file you already have' }
      : { class: 'added', translate, reason: '' }
  }
  if (change === 'deleted') {
    return {
      class: 'deleted',
      translate: false,
      reason: 'the kit removed it; you may have built on it',
    }
  }
  if (!existsLocally) {
    return { class: 'skipped-locally-deleted', translate: false, reason: 'you deleted this file' }
  }
  return { class: 'modified', translate, reason: '' }
}

// ---------------------------------------------------------------- diff surgery

const INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+( \d{6})?$/
const BINARY_MARK = /^GIT binary patch$/

/**
 * Split a `git diff` into one block per file. The block keeps its own raw text; paths come from
 * the caller (a `-z --name-status` pass), never from a regex over the `diff --git` line, because a
 * path containing a space makes that line ambiguous.
 */
export function splitDiff(patchText) {
  if (patchText.trim() === '') return []
  const lines = patchText.split('\n')
  const blocks = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) blocks.push(current)
      current = { header: line, lines: [line] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) blocks.push(current)
  return blocks.map(b => ({ header: b.header, raw: `${b.lines.join('\n').replace(/\n+$/, '')}\n` }))
}

/** Thrown when a diff carries bytes a text substitution must not touch. */
export class BinaryPatchError extends Error {
  constructor(header) {
    super(`refusing to translate a binary patch block: ${header}`)
    this.name = 'BinaryPatchError'
  }
}

/**
 * Translate one file block into the adopter's names.
 *
 * Path lines (`diff --git`, `---`, `+++`, `rename from/to`, `copy from/to`) are always translated;
 * the body only when `translate` is true. Mode lines are left verbatim — that is what preserves
 * the `120000` symlink the kit ships. `index` lines are dropped.
 */
export function translateBlock(block, names, { translate = true } = {}) {
  const lines = block.raw.split('\n')
  const out = []
  const sub = s => applyReplacements(s, names).text
  let inBody = false
  for (const line of lines) {
    if (BINARY_MARK.test(line)) throw new BinaryPatchError(block.header)
    if (INDEX_LINE.test(line)) continue
    if (line.startsWith('@@')) {
      inBody = true
      // Only the trailing section hint may carry a token; the counts are column-invariant.
      const m = line.match(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)(.*)$/)
      out.push(m ? m[1] + (translate ? sub(m[2]) : m[2]) : line)
      continue
    }
    if (!inBody) {
      if (
        line.startsWith('diff --git ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('rename from ') ||
        line.startsWith('rename to ') ||
        line.startsWith('copy from ') ||
        line.startsWith('copy to ')
      ) {
        out.push(sub(line))
        continue
      }
      out.push(line) // mode lines, similarity index, "new file mode", …
      continue
    }
    out.push(translate ? sub(line) : line)
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

/** Line count of a patch block, the invariant the hunk headers depend on. */
export function countLines(text) {
  return text.split('\n').length
}

/**
 * The block with its `index` lines removed — the correct left-hand side of the line-count
 * invariant, since `translateBlock` drops them. Translation must not change the count of
 * ANYTHING else, or a `@@` header no longer describes its hunk.
 */
export function stripIndexLines(text) {
  return text
    .split('\n')
    .filter(l => !INDEX_LINE.test(l))
    .join('\n')
}

/**
 * Translate a whole diff, dropping the blocks whose classification says they must not be applied.
 * `decide(header) → { path, class, translate }` is supplied by the caller, which knows the paths.
 */
export function translatePatch(patchText, names, decide) {
  const kept = []
  const skipped = []
  for (const block of splitDiff(patchText)) {
    const d = decide(block.header)
    if (!d || !APPLYABLE.has(d.class)) {
      skipped.push({ header: block.header, ...d })
      continue
    }
    kept.push(translateBlock(block, names, { translate: d.translate }))
  }
  return { patch: kept.join(''), kept: kept.length, skipped }
}

/** The classes that go into `apply.patch`. Everything else is reported, never applied. */
export const APPLYABLE = new Set(['modified', 'verbatim'])

// ---------------------------------------------------------------- release notes

const unquote = s => s.replace(/^["']|["']$/g, '')

/**
 * Split the inside of an inline `[a, b]` list. Quote-aware, because a `migrations` entry is a
 * human sentence and sentences contain commas — splitting on every comma silently turns one
 * description into two fragments, which is a corrupted release note rather than a failed one.
 */
function splitInlineList(inner) {
  if (inner.trim() === '') return []
  const items = []
  let current = ''
  let quote = null
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === ',') {
      items.push(current.trim())
      current = ''
    } else current += ch
  }
  items.push(current.trim())
  return items.filter(s => s !== '')
}

/**
 * Parse the YAML frontmatter of a `docs/upgrades/X.Y.Z.md`. Deliberately a tiny scalar/list
 * reader rather than a YAML dependency: the shape is fixed and asserted by a test, and the kit
 * ships no YAML parser.
 *
 * A list may be inline (`areas: [api, ui]`) or a block sequence — three long `migrations`
 * descriptions read far better one per line, and that is how a person writes them:
 *
 *     migrations:
 *       - "messages gains nullable provider and model columns"
 */
export function parseNote(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) return null
  const data = {}
  const lines = m[1].split('\n')
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([a-z_]+):\s*(.*)$/)
    if (!kv) continue
    const [, key, rawValue] = kv
    const value = rawValue.trim()
    if (value.startsWith('[')) data[key] = splitInlineList(value.slice(1, -1))
    else if (value === '') {
      // `key:` with nothing after it: either a block sequence, or an empty scalar.
      const items = []
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^\s+-\s+(.*)$/)
        if (!item) break
        items.push(unquote(item[1].trim()))
        i = j
      }
      data[key] = items.length > 0 ? items : null
    } else if (value === 'null' || value === '~') data[key] = null
    else if (value === 'true' || value === 'false') data[key] = value === 'true'
    else data[key] = unquote(value)
  }
  return { data, body: m[2] }
}

/** The headings every note must carry, in this order. */
export const NOTE_HEADINGS = Object.freeze([
  '## What changed',
  '## How to apply',
  '## Conflicts to expect',
  '## Verify',
])

/** `-1 | 0 | 1`, comparing `X.Y.Z` numerically. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  }
  return 0
}

export const VERSION_RE = /^\d+\.\d+\.\d+$/
