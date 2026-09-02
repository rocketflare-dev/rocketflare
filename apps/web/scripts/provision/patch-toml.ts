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
  /** Overwrite a different existing id instead of throwing. */
  force?: boolean
}

const PLACEHOLDER = /^<[A-Z0-9_]+>$/

export class TomlPatchError extends Error {}

/** The `id = "…"` line that follows a given `binding = "…"` line, wherever it sits in the block. */
function patchBindingId(text: string, binding: string, value: string, force: boolean): string {
  const re = new RegExp(
    `(binding\\s*=\\s*"${binding}"[^\\n]*\\n(?:[^\\n]*\\n)*?id\\s*=\\s*")([^"]*)(")`
  )
  const m = re.exec(text)
  if (!m) throw new TomlPatchError(`no \`id\` line found under binding = "${binding}"`)
  const current = m[2]
  if (current === value) return text
  if (!PLACEHOLDER.test(current) && !force) {
    throw new TomlPatchError(
      `binding "${binding}" already has id "${current}" (wanted "${value}"); pass --force to overwrite`
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

export function patchToml(text: string, patch: TomlPatch): string {
  let out = text
  const force = patch.force ?? false
  if (patch.hyperdriveId !== undefined)
    out = patchBindingId(out, 'HYPERDRIVE', patch.hyperdriveId, force)
  if (patch.kvId !== undefined) out = patchBindingId(out, 'RATE_LIMIT_KV', patch.kvId, force)
  if (patch.appUrl !== undefined) out = patchVar(out, 'APP_URL', patch.appUrl)
  if (patch.emailFrom !== undefined) out = patchVar(out, 'EMAIL_FROM', patch.emailFrom)
  if (patch.routeHost !== undefined) out = patchRoutes(out, patch.routeHost)
  if (patch.workersDevComment !== undefined)
    out = patchWorkersDevComment(out, patch.workersDevComment)
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
    'usage: tsx scripts/provision/patch-toml.ts <toml> [--hyperdrive-id ID] [--kv-id ID] [--app-url URL] [--email-from "Name <a@b>"] [--route-host HOST] [--force]'
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
    if (a === '--hyperdrive-id') patch.hyperdriveId = next()
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
