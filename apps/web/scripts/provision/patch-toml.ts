/**
 * String-level patcher for the two wrangler tomls. `wrangler --update-config` throws on the
 * commented TOML the kit ships, and re-serialising through a TOML library would drop every
 * comment, so the ids, URLs and the routes line are patched with anchored regexes and every
 * other byte is preserved. Pure: `patchToml(text, patch)` → new text; the CLI wrapper at the
 * bottom (`tsx scripts/provision/patch-toml.ts <file> --hyperdrive-id … --kv-id …`) is what
 * `cf-provision.sh --apply` calls.
 *
 * Idempotent: writing the value already present is a no-op. A DIFFERENT existing (non-placeholder)
 * id throws — an environment's Hyperdrive/KV id is not something to overwrite by accident — unless
 * `force` is set.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface TomlPatch {
  /** Value for `[[hyperdrive]] id = "<HYPERDRIVE[_STAGING]_ID>"`. */
  hyperdriveId?: string
  /** Value for `[[kv_namespaces]] id = "<KV_RATE_LIMIT[_STAGING]_ID>"`. */
  kvId?: string
  /** `[vars] APP_URL = "…"`. */
  appUrl?: string
  /** `[vars] EMAIL_FROM = "…"`. */
  emailFrom?: string
  /** Un-comment `# routes = [{ pattern = "…", custom_domain = true }]` with this host. */
  routeHost?: string
  /** Insert a `workers_dev` note after `name = …` when the file has no `workers_dev` line. */
  workersDevComment?: string
  /** Plugin binding blocks (D31): inserted if absent, updated in place if present. */
  bindings?: BindingBlock[]
  /** `[[migrations]]` entries appended when the tag is absent; an existing tag is never rewritten. */
  migrations?: MigrationBlock[]
  /** Cron expressions appended to `[triggers] crons` (idempotent). */
  crons?: string[]
  /** `[vars]` keys appended when absent (idempotent; an existing key is left alone). */
  vars?: Array<{ key: string; value: string }>
  /** Route prefixes appended to `[assets] run_worker_first` as `p` and `p/*` (idempotent). */
  workerFirstPrefixes?: string[]
  /** Overwrite a different existing id instead of throwing. */
  force?: boolean
}

/**
 * One binding block a plugin declared (D31, Decision 12). `binding` is the identity — the name the
 * Worker reads off `Cloudflare.Env` — so a block carrying it is UPDATED rather than duplicated, and
 * that is what makes re-running `pnpm provision cloudflare <env>` a no-op.
 */
export interface BindingBlock {
  type: 'kv' | 'queue' | 'r2' | 'workflow' | 'durable_object'
  binding: string
  /**
   * queue → `queue = "…"`, r2 → `bucket_name = "…"`, workflow → `name = "…"` (all account-scoped).
   * Unused for KV, which is id-referenced, and for a Durable Object, which has no resource name.
   */
  name?: string
  /** KV only: the namespace id, or a `<PLACEHOLDER>` while that environment is unprovisioned. */
  id?: string
  /** queue only: also emit a `[[queues.consumers]]` block for the same queue. */
  consumer?: boolean
  /** workflow / durable_object: the class exported from `src/worker.ts` through the sixth barrel. */
  className?: string
  /** The plugin that declared it — written into the block's comment, for a human reading the toml. */
  pluginId?: string
}

/**
 * One `[[migrations]]` entry — the record of what this Worker has already told Cloudflare about
 * its Durable Object classes. **Append-only and never renumbered**: a tag is an identity, and
 * replaying one under a different meaning loses a namespace and everything stored in it. That is
 * the same rule the SQL migrations follow, for the same reason.
 */
export interface MigrationBlock {
  tag: string
  newClasses?: string[]
  newSqliteClasses?: string[]
  deletedClasses?: string[]
  /** The plugin that declared it — written into the block's comment. */
  pluginId?: string
}

const PLACEHOLDER = /^<[A-Z0-9_]+>$/

export class TomlPatchError extends Error {}

/**
 * The `<key> = "…"` line that follows a given `binding = "…"` line INSIDE the same block. The
 * intervening lines must each be non-empty (`[^\n]+`), which is what stops the match running past
 * a blank line into the next block and rewriting a different binding's id.
 */
function patchBindingKey(
  text: string,
  binding: string,
  key: string,
  value: string,
  force: boolean,
  idKey = 'binding'
): string {
  const re = new RegExp(
    `(${escapeRe(idKey)}\\s*=\\s*"${escapeRe(binding)}"[^\\n]*\\n(?:[^\\n]+\\n)*?${key}\\s*=\\s*")([^"]*)(")`
  )
  const m = re.exec(text)
  if (!m) throw new TomlPatchError(`no \`${key}\` line found under binding = "${binding}"`)
  const current = m[2]
  if (current === value) return text
  if (!PLACEHOLDER.test(current) && !force) {
    throw new TomlPatchError(
      `binding "${binding}" already has ${key} "${current}" (wanted "${value}"); pass --force to overwrite`
    )
  }
  return text.slice(0, m.index) + m[1] + value + m[3] + text.slice(m.index + m[0].length)
}

/** Replace the quoted value of a top-of-line `KEY = "…"` assignment, keeping any trailing comment. */
function patchVar(text: string, key: string, value: string): string {
  const re = new RegExp(`^(${key}\\s*=\\s*")([^"]*)(")`, 'm')
  const m = re.exec(text)
  if (!m) throw new TomlPatchError(`no \`${key} = "…"\` line found`)
  if (m[2] === value) return text
  return text.slice(0, m.index) + m[1] + value + m[3] + text.slice(m.index + m[0].length)
}

function patchRoutes(text: string, host: string): string {
  const line = `routes = [{ pattern = "${host}", custom_domain = true }]`
  // Already active with this host → no-op.
  if (new RegExp(`^routes\\s*=\\s*\\[\\{\\s*pattern\\s*=\\s*"${escapeRe(host)}"`, 'm').test(text))
    return text
  // Active with another host → replace the line.
  const active = /^routes\s*=\s*\[[^\n]*\]/m.exec(text)
  if (active)
    return text.slice(0, active.index) + line + text.slice(active.index + active[0].length)
  // Commented template → un-comment and set the host.
  const commented = /^#\s*routes\s*=\s*\[[^\n]*\]/m.exec(text)
  if (!commented) throw new TomlPatchError('no `routes = [...]` line (active or commented) found')
  return text.slice(0, commented.index) + line + text.slice(commented.index + commented[0].length)
}

function patchWorkersDevComment(text: string, comment: string): string {
  if (/^\s*#?\s*workers_dev\s*=/m.test(text)) return text
  const nameLine = /^name\s*=\s*"[^"]*"[^\n]*\n/m.exec(text)
  if (!nameLine) throw new TomlPatchError('no `name = "…"` line found')
  const insertAt = nameLine.index + nameLine[0].length
  const lines = comment
    .split('\n')
    .map(l => `# ${l}`)
    .join('\n')
  return `${text.slice(0, insertAt)}${lines}\n${text.slice(insertAt)}`
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---- plugin blocks and list appends (D31, Decision 12) ------------------------------------

/**
 * The byte range of every array-of-tables block with a given header. A block runs from its header
 * line to the first BLANK line or the next `[` at column 0 — which is how the kit's tomls are
 * written, one blank line between blocks, and it is the only structure this patcher needs. Parsing
 * the document properly would mean re-serialising it, which loses every comment (see the header).
 */
function blockRanges(text: string, header: string): Array<{ start: number; end: number }> {
  const lines = text.split('\n')
  const offsets: number[] = []
  let at = 0
  for (const line of lines) {
    offsets.push(at)
    at += line.length + 1
  }
  const out: Array<{ start: number; end: number }> = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== header) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() !== '' && !/^\[/.test(lines[j])) j++
    out.push({ start: offsets[i], end: offsets[j] ?? text.length })
  }
  return out
}

/** Does any block under `header` carry `key = "value"`? (How a consumer block is identified.) */
function blockHasKeyValue(text: string, header: string, key: string, value: string): boolean {
  const re = new RegExp(`^${escapeRe(key)}\\s*=\\s*"${escapeRe(value)}"\\s*(?:#.*)?$`, 'm')
  return blockRanges(text, header).some(r => re.test(text.slice(r.start, r.end)))
}

/**
 * Insert a whole block after the LAST block of the same kind, so plugin bindings gather beside the
 * kit's own rather than at the end of the file. With no block of that kind at all — an app that
 * deleted the kit's R2 bucket, say — the block is appended at the end of the file instead, which is
 * valid TOML and visible in `git diff` either way.
 */
function insertBlock(text: string, header: string, body: string): string {
  const existing = blockRanges(text, header)
  const block = `${body.trimEnd()}\n`
  if (existing.length === 0) {
    const tail = text.endsWith('\n') ? text : `${text}\n`
    return `${tail}\n${block}`
  }
  const at = existing[existing.length - 1].end
  const before = text.slice(0, at)
  // `end` sits ON the blank line that terminates the block (or at EOF), so a blank line goes in
  // front of the new block and the existing one stays behind it — a block that touches its
  // neighbour would also break `blockRanges`, which reads a blank line as the terminator.
  const after = text.slice(at)
  const separated = after === '' || after.startsWith('\n') ? after : `\n${after}`
  return `${before}\n${block}${separated}`
}

/**
 * Where each binding type's block lives, how a block is IDENTIFIED inside that section, and which
 * key carries the per-environment value.
 *
 * `idKey` is not always `binding`, and that is a real wrinkle rather than a preference:
 * `[[durable_objects.bindings]]` spells the binding name as `name` (the kit's own
 * `NOTIFICATIONS_HUB` is `name = "NOTIFICATIONS_HUB"`), so a patcher keyed on `binding` would
 * insert a second block beside an existing one every time it ran.
 *
 * `valueKey` is null where the block has nothing that differs per environment — a Durable Object
 * binding is byte-identical in both files, so an upsert is insert-if-absent and nothing else.
 */
const SECTION: Record<
  BindingBlock['type'],
  { header: string; idKey: string; valueKey: string | null }
> = {
  kv: { header: '[[kv_namespaces]]', idKey: 'binding', valueKey: 'id' },
  queue: { header: '[[queues.producers]]', idKey: 'binding', valueKey: 'queue' },
  r2: { header: '[[r2_buckets]]', idKey: 'binding', valueKey: 'bucket_name' },
  workflow: { header: '[[workflows]]', idKey: 'binding', valueKey: 'name' },
  durable_object: { header: '[[durable_objects.bindings]]', idKey: 'name', valueKey: null },
}

function bindingComment(block: BindingBlock): string {
  const who = block.pluginId ? `plugin ${block.pluginId}` : 'plugin'
  return `# ${who}: declared in its plugin.json; inserted by \`pnpm provision cloudflare <env>\`.`
}

/**
 * Insert or update one plugin binding block. Idempotent by `binding` name: a block that already
 * declares it is UPDATED in place (a different existing, non-placeholder value is refused unless
 * `force`), never duplicated — two blocks for one binding is a toml wrangler accepts and a Worker
 * cannot be reasoned about.
 */
function upsertBindingBlock(text: string, block: BindingBlock, force: boolean): string {
  const section = SECTION[block.type]
  if (!section) throw new TomlPatchError(`unsupported binding type "${block.type}"`)
  if (block.type === 'workflow' || block.type === 'durable_object') {
    if (!block.className)
      throw new TomlPatchError(
        `binding "${block.binding}": className is required for a ${block.type}`
      )
  }
  const value = block.type === 'kv' ? block.id : block.name
  if (section.valueKey !== null && value === undefined)
    throw new TomlPatchError(
      `binding "${block.binding}": ${block.type === 'kv' ? 'id' : 'name'} is required`
    )
  let out = text
  const declared = new RegExp(
    `^${escapeRe(section.idKey)}\\s*=\\s*"${escapeRe(block.binding)}"\\s*(?:#.*)?$`,
    'm'
  )
  if (blockRanges(out, section.header).some(r => declared.test(out.slice(r.start, r.end)))) {
    // Only the per-environment value is ever rewritten. `class_name` is identical in both files and
    // a plugin may not rename a class across releases (expand/contract, like every other name), so
    // patching it would be writing over something nothing is allowed to have changed.
    if (section.valueKey !== null && value !== undefined) {
      out = patchBindingKey(
        out,
        block.binding,
        section.valueKey,
        value as string,
        force,
        section.idKey
      )
    }
  } else {
    const lines = [bindingComment(block), section.header]
    if (block.type === 'durable_object') {
      lines.push(`name = "${block.binding}"`, `class_name = "${block.className}"`)
    } else {
      lines.push(`binding = "${block.binding}"`)
      if (section.valueKey) lines.push(`${section.valueKey} = "${value}"`)
      if (block.className) lines.push(`class_name = "${block.className}"`)
    }
    out = insertBlock(out, section.header, lines.join('\n'))
  }
  if (block.type === 'queue' && block.consumer && value !== undefined) {
    const header = '[[queues.consumers]]'
    if (!blockHasKeyValue(out, header, 'queue', value)) {
      // The kit's own consumer settings: a plugin that wants different ones edits the block.
      out = insertBlock(
        out,
        header,
        `${header}\nqueue = "${value}"\nmax_batch_size = 10\nmax_batch_timeout = 5\nmax_retries = 3\nretry_delay = 60`
      )
    }
  }
  return out
}

/**
 * Append values to a `key = [ … ]` array, skipping any already present. Multi-line arrays (the
 * kit's `crons` and `run_worker_first`) keep their one-entry-per-line shape and its indentation;
 * a single-line array stays single-line.
 */
function appendToArray(text: string, key: string, values: string[]): string {
  const re = new RegExp(`^${escapeRe(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm')
  const m = re.exec(text)
  if (!m) throw new TomlPatchError(`no \`${key} = [...]\` array found`)
  const inner = m[1]
  const present = new Set([...inner.matchAll(/"([^"]*)"/g)].map(x => x[1]))
  const missing = values.filter(v => !present.has(v))
  if (missing.length === 0) return text
  let replacement: string
  if (inner.includes('\n')) {
    const indentMatch = /\n([ \t]+)\S/.exec(inner)
    const indent = indentMatch?.[1] ?? '  '
    const added = missing.map(v => `${indent}"${v}",`).join('\n')
    const trailing = /\n[ \t]*$/.test(inner)
      ? inner.replace(/\n[ \t]*$/, '')
      : inner.replace(/\s+$/, '')
    const closeIndent = /\n([ \t]*)$/.exec(inner)?.[1] ?? ''
    replacement = `${key} = [${trailing}\n${added}\n${closeIndent}]`
  } else {
    const items = [...present, ...missing].map(v => `"${v}"`).join(', ')
    replacement = `${key} = [${items}]`
  }
  return text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length)
}

/**
 * Append `KEY = "value"` to `[vars]` when the key is absent, placed after the LAST assignment in
 * the table rather than at its end — the kit's `[vars]` closes with a comment about secrets, and a
 * new key belongs above it. An existing key is left exactly as it is: its value is the operator's.
 */
function appendVar(text: string, key: string, value: string): string {
  if (new RegExp(`^${escapeRe(key)}\\s*=`, 'm').test(text)) return text
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trim() === '[vars]')
  if (start === -1) throw new TomlPatchError('no `[vars]` table found')
  let last = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[/.test(lines[i])) break
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(lines[i])) last = i
  }
  if (last === -1) last = start
  const insertAt = lines.slice(0, last + 1).reduce((n, l) => n + l.length + 1, 0)
  return `${text.slice(0, insertAt)}${key} = "${value}"\n${text.slice(insertAt)}`
}

/**
 * Append a `[[migrations]]` entry when its tag is absent. An existing tag is left EXACTLY as it is,
 * whatever it says: the tag is the identity Cloudflare has already acted on, so rewriting one is
 * how a Durable Object namespace and its contents are lost.
 */
function appendMigration(text: string, block: MigrationBlock): string {
  const header = '[[migrations]]'
  if (blockHasKeyValue(text, header, 'tag', block.tag)) return text
  const lines = [
    `# ${block.pluginId ? `plugin ${block.pluginId}` : 'plugin'}: Durable Object classes, appended by \`pnpm provision cloudflare <env>\`.`,
    '# Append-only — never renumber or rewrite a tag Cloudflare has already applied.',
    header,
    `tag = "${block.tag}"`,
  ]
  const list = (key: string, classes?: string[]) => {
    if (!classes?.length) return
    lines.push(`${key} = [${classes.map(c => `"${c}"`).join(', ')}]`)
  }
  list('new_classes', block.newClasses)
  list('new_sqlite_classes', block.newSqliteClasses)
  list('deleted_classes', block.deletedClasses)
  return insertBlock(text, header, lines.join('\n'))
}

export function patchToml(text: string, patch: TomlPatch): string {
  let out = text
  const force = patch.force ?? false
  if (patch.hyperdriveId !== undefined)
    out = patchBindingKey(out, 'HYPERDRIVE', 'id', patch.hyperdriveId, force)
  if (patch.kvId !== undefined) out = patchBindingKey(out, 'RATE_LIMIT_KV', 'id', patch.kvId, force)
  if (patch.appUrl !== undefined) out = patchVar(out, 'APP_URL', patch.appUrl)
  if (patch.emailFrom !== undefined) out = patchVar(out, 'EMAIL_FROM', patch.emailFrom)
  if (patch.routeHost !== undefined) out = patchRoutes(out, patch.routeHost)
  if (patch.workersDevComment !== undefined)
    out = patchWorkersDevComment(out, patch.workersDevComment)
  for (const block of patch.bindings ?? []) out = upsertBindingBlock(out, block, force)
  for (const block of patch.migrations ?? []) out = appendMigration(out, block)
  if (patch.crons?.length) out = appendToArray(out, 'crons', patch.crons)
  if (patch.workerFirstPrefixes?.length)
    out = appendToArray(
      out,
      'run_worker_first',
      patch.workerFirstPrefixes.flatMap(p => [p, `${p}/*`])
    )
  for (const v of patch.vars ?? []) out = appendVar(out, v.key, v.value)
  return out
}

/** Read a top-level `KEY = "…"` (or `[vars]` key) value without parsing the whole document. */
export function readTomlString(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(text)
  return m?.[1]
}

/** Every `<PLACEHOLDER>` string value still present in the text. */
export function tomlPlaceholders(text: string): string[] {
  return [...text.matchAll(/"(<[A-Z0-9_]+>)"/g)].map(m => m[1])
}

/** Patch a file in place; returns whether anything changed. */
export function patchTomlFile(file: string, patch: TomlPatch): boolean {
  const before = fs.readFileSync(file, 'utf8')
  const after = patchToml(before, patch)
  if (after === before) return false
  fs.writeFileSync(file, after)
  return true
}

// ---- CLI ---------------------------------------------------------------------------------

function usage(): never {
  console.error(
    'usage: tsx scripts/provision/patch-toml.ts <toml> [--hyperdrive-id ID] [--kv-id ID] [--app-url URL] [--email-from "Name <a@b>"] [--route-host HOST] [--binding \'{"type":"kv","binding":"X","id":"…"}\']… [--force]'
  )
  process.exit(2)
}

function main(argv: string[]) {
  const file = argv[0]
  if (!file || file.startsWith('--')) usage()
  const patch: TomlPatch = {}
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) usage()
      return v
    }
    if (a === '--binding') {
      const raw = next()
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        console.error(`--binding is not valid JSON: ${raw}`)
        process.exit(2)
      }
      patch.bindings = [...(patch.bindings ?? []), parsed as BindingBlock]
    } else if (a === '--hyperdrive-id') patch.hyperdriveId = next()
    else if (a === '--kv-id') patch.kvId = next()
    else if (a === '--app-url') patch.appUrl = next()
    else if (a === '--email-from') patch.emailFrom = next()
    else if (a === '--route-host') patch.routeHost = next()
    else if (a === '--force') patch.force = true
    else usage()
  }
  try {
    const changed = patchTomlFile(file, patch)
    console.log(`${file}: ${changed ? 'patched' : 'already up to date'}`)
  } catch (err) {
    console.error(`${file}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

const invokedPath = process.argv[1]
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) main(process.argv.slice(2))
