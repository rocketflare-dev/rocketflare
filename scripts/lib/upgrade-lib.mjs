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
  'skipped-plugin-owned',
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
  // A plugin (D31) owns its own files and its own release chain: `pnpm plugin upgrade <id>` ports
  // them from the plugin's repository. A KIT diff must never touch those bytes — the kit does not
  // know what version of the plugin is installed, and the two histories would fight. This sits
  // second, right after "the adopter deleted it", because both are about not writing where the kit
  // has no say.
  if (surface && surface.kind === 'plugin') {
    return {
      class: 'skipped-plugin-owned',
      translate: false,
      reason: `plugin ${surface.id} owns this file — use \`pnpm plugin upgrade ${surface.id}\``,
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

/** The frontmatter fields that must be lists, even when empty. */
const NOTE_LIST_FIELDS = Object.freeze([
  'migrations',
  'areas',
  'touches_surfaces',
  'requires_surfaces',
])

/**
 * Everything wrong with one porting note, as sentences. Empty means it is well formed.
 *
 * **One statement of the note schema, for every reader of it.** It was written out in four places
 * and the four had already drifted — most expensively over retired surfaces: only the test knew
 * that an id a LATER release removed must still be accepted, so `release-check.mjs --tag 0.3.0`
 * reported a released note as broken over a surface 0.6.0 had deliberately deleted. The kit could
 * not re-verify its own history, and the note it complained about is one it forbids rewriting.
 *
 * Pure, so a test can drive it over fixtures as well as over the notes on disk:
 *
 *   - `version` is the filename's stem. Pass `null` for `unreleased.md`, which has no version and
 *     no date yet, and both checks are skipped rather than failed.
 *   - `expectPrevious` is checked only when given, because the CALLER is what knows the chain;
 *     the baseline note expects the string `'null'`.
 *   - `surfaceIds` null skips the surface check entirely — the honest answer when the caller has no
 *     manifest, rather than reporting every id in the note as unknown.
 *   - `retiredSurfaceIds` is `.rocketflare.json`'s `retiredSurfaces`: ids that were real when the
 *     note was written and have since been removed on purpose.
 */
export function noteProblems(
  text,
  {
    file = 'the note',
    version = null,
    expectPrevious,
    surfaceIds = null,
    retiredSurfaceIds = {},
    // Named by the caller rather than written here: the provenance file keeps the KIT's name in a
    // renamed copy, so a literal in this file would be rewritten into one that does not exist.
    manifestFile = 'the manifest',
  } = {}
) {
  const problems = []
  const say = message => `${file}: ${message}`
  const parsed = parseNote(text)
  if (!parsed) return [say('no YAML frontmatter')]
  const { data, body } = parsed

  if (version !== null && data.version !== version) {
    problems.push(say(`frontmatter version is '${data.version}', the filename says '${version}'`))
  }
  if (version !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.date ?? ''))) {
    problems.push(say(`date is '${data.date}', expected YYYY-MM-DD`))
  }
  if (expectPrevious !== undefined && (data.previous ?? 'null') !== expectPrevious) {
    problems.push(
      say(
        `previous is '${data.previous}', expected '${expectPrevious}' — the chain /rf-upgrade walks must be unbroken`
      )
    )
  }
  for (const key of ['breaking', 'manual']) {
    if (typeof data[key] !== 'boolean') problems.push(say(`${key} must be true or false`))
  }
  for (const key of NOTE_LIST_FIELDS) {
    if (!Array.isArray(data[key])) problems.push(say(`${key} must be a list`))
  }
  for (const m of data.migrations ?? []) {
    if (/\.sql$|^\d{4}_/.test(m)) {
      problems.push(
        say(
          `migrations names a file ('${m}') — describe the change; an adopter regenerates their own`
        )
      )
    }
  }
  if (surfaceIds) {
    const known = new Set(surfaceIds)
    for (const key of ['touches_surfaces', 'requires_surfaces']) {
      for (const id of data[key] ?? []) {
        // A surface a later release retired is still named by every note that shipped before it,
        // and released history is never rewritten — so it is accepted rather than reported.
        if (retiredSurfaceIds[id]) continue
        if (!known.has(id)) {
          problems.push(say(`${key} names '${id}', which is not a surface in ${manifestFile}`))
        }
      }
    }
  }
  let cursor = -1
  for (const heading of NOTE_HEADINGS) {
    const found = body.indexOf(`\n${heading}`)
    if (found === -1) problems.push(say(`missing the '${heading}' heading`))
    else if (found < cursor) problems.push(say(`'${heading}' is out of order`))
    else cursor = found
  }
  return problems
}

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

/**
 * Does `text` carry a `## <version>` section?
 *
 * Anchored, and the anchoring is the whole point: `changelog.includes('## 0.6.1')` also matches
 * `## 0.6.10`, so the day a kit reaches a two-digit patch the tag gate starts passing on a section
 * that belongs to a different release — and passing is the dangerous direction here.
 */
export function hasChangelogSection(text, version) {
  return new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`, 'm').test(text)
}

/**
 * The `## X.Y.Z — <date>` section a release prepends to `CHANGELOG.md`, from one entry per note.
 *
 * ONE entry renders exactly as it always has — a summary paragraph, then the link — because the
 * kit and every single-plugin repository have exactly one porting note per release and their
 * changelogs are already written that way. SEVERAL entries is the plugin monorepo (D31), where one
 * release covers every plugin in the repository: an unlabelled paragraph followed by three links
 * says nothing about which summary belongs to which plugin, so each one is named.
 */
export function changelogSection(version, date, entries) {
  const body =
    entries.length === 1
      ? `${entries[0].summary}\n[Porting note](${entries[0].note}).\n`
      : entries.map(e => `**${e.id}** — ${e.summary}\n[Porting note](${e.note}).\n`).join('\n')
  return `## ${version} — ${date}\n\n${body}\n`
}

/**
 * Put `section` above the newest existing one, or at the end of a changelog that has none yet.
 * Split out of `scripts/release.mjs` only so that a test can drive it.
 */
export function prependChangelogSection(text, section) {
  const at = text.indexOf('\n## ')
  return at === -1 ? `${text}\n${section}` : text.slice(0, at + 1) + section + text.slice(at + 1)
}

// ---------------------------------------------------------------- behaviour changes

/**
 * What counts as a BEHAVIOUR change for the porting-note rule: source under `apps/` or `packages/`,
 * excluding tests and markdown.
 *
 * One definition, two readers — `scripts/release-check.mjs --unreleased` (the CI gate) and
 * `scripts/changelog-nudge.mjs` (the pre-commit hook). They have to agree by construction: a hook
 * that nudges for a file CI ignores teaches people to ignore the hook, and one that stays quiet for
 * a file CI fails on is worse still.
 */
export const BEHAVIOUR_PATH_RE = /^(apps|packages)\//
export const BEHAVIOUR_EXEMPT_RE = /(^|\/)(tests?|__tests__)\/|\.test\.(ts|tsx)$|\.md$/

/**
 * The subset of `changed` that needs an entry in `docs/upgrades/unreleased.md`.
 *
 * `within` is the subdirectory the predicate is applied INSIDE, and it exists for the plugin
 * MONOREPO (D31). There a plugin's source is `plugins/<id>/apps/web/src/...`, so the bare
 * `^(apps|packages)/` matches nothing at all and the gate passes silently on every change it was
 * written to catch — the worst failure this check has, because it looks exactly like success.
 * Stripping the prefix first asks the same question of the plugin's own tree; what comes back is
 * still repo-root-relative, because that is what the caller compares against the list of changed
 * paths it was handed. Empty (the default) is the kit and a single-plugin repository, unchanged.
 */
export function behaviourFiles(changed, { within = '' } = {}) {
  const prefix = within === '' ? '' : `${within.replace(/\/+$/, '')}/`
  return (changed ?? []).filter(f => {
    if (!f.startsWith(prefix)) return false
    const rel = f.slice(prefix.length)
    return BEHAVIOUR_PATH_RE.test(rel) && !BEHAVIOUR_EXEMPT_RE.test(rel)
  })
}

// ---------------------------------------------------------------- default plugins (D31, decision 5)

/**
 * The `defaultPlugins` list from `.rocketflare.json`, normalised.
 *
 * **The shape is an OBJECT per entry** — `{ id, repo, ref?, subdir? }` — because a default plugin
 * has to be installable by a machine that has only this file: a bare id says nothing about where
 * the plugin comes from, and decision 13 already made `repo` required of every plugin manifest for
 * exactly that reason. `ref` is the pinned tag CI installs (omitted = the repository's default
 * branch, which is a moving target and only sensible while a plugin is being written). A plain
 * STRING is accepted and normalised to `{ id, repo: null }` so an older manifest still parses, but
 * it has no repo and every consumer below reports that as a problem rather than guessing a URL.
 */
export function defaultPluginEntries(manifest) {
  return (manifest?.defaultPlugins ?? []).map(entry =>
    typeof entry === 'string'
      ? { id: entry, repo: null, ref: null, subdir: '' }
      : {
          id: entry.id ?? null,
          repo: entry.repo ?? null,
          ref: entry.ref ?? null,
          subdir: entry.subdir ?? '',
        }
  )
}

/**
 * A vendored plugin is the kit's own: the same repository, with no subdirectory (§16).
 *
 * **One implementation, and it lives here because everything else can import it.** There were two,
 * and they did not agree: this one normalises the URL (a trailing `/` or a missing `.git` still
 * names the same repository) while `plugin-lib.mjs`'s compared the strings exactly — so one plugin
 * could be vendored for `kit:release` and third-party for `plugin check`, in one checkout, over one
 * manifest. `plugin-lib.mjs` re-exports this under the same name; the dependency can only run that
 * way round, since `plugin-lib.mjs` already imports this file.
 *
 * Takes anything shaped `{ repo, subdir }` — a `defaultPlugins` entry and a surface's `source`
 * block are the two callers, and they are the same two fields.
 */
export function isVendored(source, kitRepo) {
  // Trailing slashes FIRST, then `.git` — the other order leaves `…/rocketflare.git/` as
  // `…/rocketflare.git` while the bare form normalises to `…/rocketflare`, so the same repository
  // reads as two. (The implementation this replaced had exactly that bug, unnoticed because
  // nothing ever passed it a trailing slash.)
  const norm = r =>
    (r ?? '')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
  const repo = norm(source?.repo)
  return repo !== '' && repo === norm(kitRepo) && (source?.subdir ?? '') === ''
}

/**
 * Why this version must NOT be released — one sentence per problem, empty when it may be.
 *
 * Pure: `resolve(entry)` is injected and does the I/O (reach the repository, read its
 * `rocketflare-plugin.json`). It returns `{ ok, reason?, minKit?, legacyRange?, version? }`.
 *
 * What this proves and what it does not, stated plainly because the difference matters: it proves
 * every default plugin is still FETCHABLE at the ref the kit pins, and that the version being cut
 * is at or above the `minKit` floor it declares — one integer comparison, no range language. It
 * does not prove that plugin's tests pass against it, and nothing a release script can do proves
 * that. The kit's own CI installs every default plugin and runs the full gate on the release
 * commit (`.github/workflows/ci.yml`), and each plugin repository runs the mirrored check against
 * the kit (`.github/workflows/plugin-ci.yml`). Those two are the compatibility proof; this is the
 * stop that catches a pin nobody updated.
 *
 * A VENDORED entry (the kit's own repository, no subdirectory) is exempt from the floor check for
 * the reason §16 gives: the same release cut both, so the floor describes the kit it shipped inside
 * rather than a compatibility claim.
 */
/**
 * Everything malformed about a `defaultPlugins` LIST, as sentences — the shape check, with no I/O.
 *
 * One validator, four callers: `defaultPluginProblems` below, `planDefaultPlugins` (the bootstrap
 * step), and the two GitHub workflows, which now reach it through `scripts/default-plugins.mjs`
 * rather than each inlining a `node -e` block. They had already drifted: the bootstrap called a
 * bare string "not an object", this file called it an id with no repo, and the workflows only ever
 * checked truthiness — three answers to one question, in the file that decides what a fresh clone
 * installs.
 */
export function defaultPluginEntryProblems(entries) {
  const problems = []
  const seen = new Set()
  for (const entry of entries ?? []) {
    if (!entry.id) {
      problems.push('a defaultPlugins entry has no "id"')
      continue
    }
    if (seen.has(entry.id)) problems.push(`defaultPlugins lists '${entry.id}' twice`)
    seen.add(entry.id)
    if (!entry.repo) {
      problems.push(
        `defaultPlugins '${entry.id}' has no "repo" — a default plugin CI cannot fetch is a default plugin nobody can install`
      )
    }
  }
  return problems
}

export function defaultPluginProblems(entries, version, resolve, { kitRepo = null } = {}) {
  // Shape first, and every shape problem at once: somebody fixing a hand-edited list wants the
  // whole of it, not one sentence per run.
  const problems = defaultPluginEntryProblems(entries)
  for (const entry of entries) {
    const id = entry.id ?? '(unnamed)'
    if (!entry.id || !entry.repo) continue
    const resolved = resolve(entry) ?? { ok: false, reason: 'not resolved' }
    if (!resolved.ok) {
      problems.push(
        `defaultPlugins '${id}' (${entry.repo}${entry.ref ? `@${entry.ref}` : ''}): ${resolved.reason}`
      )
      continue
    }
    if (isVendored(entry, kitRepo)) continue
    const at = resolved.version ? ` ${resolved.version}` : ''
    const floor = resolved.minKit
    // Three answers, three fixes, and conflating any two of them is how this gate stops meaning
    // anything: a plugin still on the OLD shape, a plugin whose declaration could not be read at
    // all, and a plugin that read fine and does not admit the version being cut.
    if (floor == null) {
      problems.push(
        resolved.legacyRange
          ? `defaultPlugins '${id}'${at} declares requires.kit '${resolved.legacyRange}', a semver RANGE this kit no longer reads — release the plugin with a top-level "minKit": "X.Y.Z" instead (one floor, no ceiling), then repin it here`
          : `defaultPlugins '${id}': cannot read its minKit floor — install it (\`pnpm plugin add\`) or keep a mirror, so the pin can be checked`
      )
      continue
    }
    // A floor that is not one bare version is the old shape wearing the new field's name, and it
    // is reported rather than approximated: there is no range machinery left here to fall back on.
    if (!VERSION_RE.test(floor)) {
      problems.push(
        `defaultPlugins '${id}'${at} declares minKit '${floor}', which is not a bare X.Y.Z version — minKit is a FLOOR, not a range`
      )
      continue
    }
    if (compareVersions(version, floor) < 0) {
      problems.push(
        `defaultPlugins '${id}'${at} needs kit ${floor} or newer, and this release is ${version} — raise the version, or repin to a plugin release that supports it`
      )
    }
  }
  return problems
}
