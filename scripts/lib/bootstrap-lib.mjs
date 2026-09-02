/**
 * Pure helpers for `scripts/bootstrap.mjs` — no I/O, no process access, so
 * `apps/web/tests/config/bootstrap-lib.test.ts` can pin every text transformation the bootstrap
 * performs on files it does not own (`.dev.vars`, the two wrangler tomls) and every parser it
 * applies to another tool's stdout (`pnpm seed`, `wrangler whoami`). Types: `bootstrap-lib.d.mts`.
 */

/** The major version in an `.nvmrc` (`24`, `v24.1.0`, `lts/*` → NaN). */
export function parseNvmrc(text) {
  const match = /^\s*v?(\d+)/.exec(text)
  return match ? Number(match[1]) : Number.NaN
}

/** `versionAtLeast('v24.16.0', 24)` → true. Tolerates a leading `v` and trailing text. */
export function versionAtLeast(vString, major) {
  const match = /^\s*v?(\d+)/.exec(vString ?? '')
  return match ? Number(match[1]) >= major : false
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/** `KEY=`, `KEY=""` and `KEY=''` are all "unset" (config.ts treats a blank secret as absent). */
function isEmptyValue(value) {
  const v = value.trim()
  return v === '' || v === '""' || v === "''"
}

/**
 * Bring a `.dev.vars` up to the example's shape without touching anything a person wrote.
 *
 * - `existingText === null` → start from the example.
 * - Every required key that is empty is filled with `generate()`; a non-empty value is never
 *   overwritten. A required key the file does not have at all is appended, filled.
 * - Comments, blank lines, order and keys the example does not know are preserved byte for byte.
 * - `missing` lists the OPTIONAL keys the example has and the file lacks (a warning, not a fix).
 */
export function fillDevVars(exampleText, existingText, generate, requiredKeys) {
  const source = existingText ?? exampleText
  const lines = source.split('\n')
  const filled = []
  const present = new Set()
  const out = lines.map(line => {
    const match = KEY_LINE.exec(line)
    if (!match) return line
    const [, key, value] = match
    present.add(key)
    if (requiredKeys.includes(key) && isEmptyValue(value)) {
      filled.push(key)
      return `${key}=${generate()}`
    }
    return line
  })
  const exampleKeys = exampleText
    .split('\n')
    .map(line => KEY_LINE.exec(line)?.[1])
    .filter(key => key !== undefined)
  const missing = []
  const appended = []
  for (const key of exampleKeys) {
    if (present.has(key)) continue
    if (requiredKeys.includes(key)) {
      appended.push(`${key}=${generate()}`)
      filled.push(key)
    } else {
      missing.push(key)
    }
  }
  for (const key of requiredKeys) {
    if (!present.has(key) && !exampleKeys.includes(key)) {
      appended.push(`${key}=${generate()}`)
      filled.push(key)
    }
  }
  let text = out.join('\n')
  if (appended.length > 0) {
    if (!text.endsWith('\n')) text += '\n'
    text += `${appended.join('\n')}\n`
  }
  return { text, filled, missing }
}

/** Values of the `KEY=value` lines in a dotenv text (quotes stripped), for verification. */
export function readDevVars(text) {
  const values = {}
  for (const line of text.split('\n')) {
    const match = KEY_LINE.exec(line)
    if (!match) continue
    const raw = match[2].trim()
    values[match[1]] = isEmptyValue(raw) ? '' : raw.replace(/^(["'])(.*)\1$/, '$2')
  }
  return values
}

const AI_ON = /^\[ai\]\s*$/
const AI_OFF = /^# \[ai\]\s*$/
const SECTION = /^\s*\[/

/** `'on'` when `[ai]` is live, `'off'` when the bootstrap commented it out, else `'absent'`. */
export function aiBlockState(tomlText) {
  for (const line of tomlText.split('\n')) {
    if (AI_ON.test(line)) return 'on'
    if (AI_OFF.test(line)) return 'off'
  }
  return 'absent'
}

/**
 * Comment out (`'off'`) or restore (`'on'`) the `[ai]` block, text-level, so every other byte of
 * the toml — including the block's own explanatory comments — survives a round trip.
 *
 * `off` prefixes EVERY line of the block (header, keys and comment lines alike) with `# `, from
 * the `[ai]` header to the next blank line or the next `[section]` header. `on` strips exactly
 * one leading `# ` from every line of that commented block. Because the rule is uniform, an
 * original comment becomes `# # …` and comes back byte-identical; nothing has to be marked.
 * Idempotent: the current state is checked first and a no-op returns the text unchanged.
 * `on` therefore relies on the blank line that ends the block in both tomls (the test pins it):
 * delete that blank line and the following section's comment would be uncommented too.
 */
export function toggleAiBlock(tomlText, mode) {
  const state = aiBlockState(tomlText)
  if (state === 'absent' || state === mode) return tomlText
  const lines = tomlText.split('\n')
  const header = mode === 'off' ? AI_ON : AI_OFF
  const start = lines.findIndex(line => header.test(line))
  let end = start + 1
  if (mode === 'off') {
    while (end < lines.length && lines[end].trim() !== '' && !SECTION.test(lines[end])) end += 1
  } else {
    while (end < lines.length && lines[end].startsWith('# ')) end += 1
  }
  const block = lines.slice(start, end).map(line => (mode === 'off' ? `# ${line}` : line.slice(2)))
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n')
}

/**
 * The plaintext API key `pnpm seed` prints exactly once — the first non-empty line after its
 * "API key (shown ONCE" banner. Position-based on purpose: an adapted kit renames the prefix.
 * The "already exists" variant prints no banner and yields `undefined`.
 */
export function extractSeedKey(stdout) {
  const lines = stdout.split('\n')
  const banner = lines.findIndex(line => line.includes('API key (shown ONCE'))
  if (banner === -1) return undefined
  const next = lines.slice(banner + 1).find(line => line.trim() !== '')
  return next?.trim() || undefined
}

// Built, not a literal: a regex literal with the escape byte in it trips biome's control-char rule.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/**
 * `wrangler whoami` → `{ loggedIn, email?, account? }`. Logged in: "You are logged in with an
 * OAuth Token, associated with the email you@example.com." then a box table whose first data row
 * is `│ Account Name │ Account ID │`. Logged out: "You are not authenticated. Please run
 * `wrangler login`." Hand it stdout and stderr together; ANSI is stripped first.
 */
export function parseWhoami(stdout) {
  const text = (stdout ?? '').replace(ANSI, '')
  if (!/You are logged in with/i.test(text)) return { loggedIn: false }
  const result = { loggedIn: true }
  const email = /associated with the email\s+(\S+?)\.?\s*$/im.exec(text)
  if (email) result.email = email[1]
  const rows = text
    .split('\n')
    .filter(line => line.trim().startsWith('│'))
    .map(line =>
      line
        .split('│')
        .map(cell => cell.trim())
        .filter(cell => cell !== '')
    )
  const data = rows.find(cells => cells.length >= 2 && cells[0] !== 'Account Name')
  if (data) result.account = data[0]
  return result
}
