/**
 * JSON written the way Biome formats it (`biome.json`: 2-space indent, `lineWidth` 100), so a file a
 * script rewrites — `.rocketflare.json` above all — passes the copy's own `pnpm lint` untouched.
 * `JSON.stringify(v, null, 2)` puts every array element on its own line; Biome puts an array on ONE
 * line when it fits, and every `pnpm kit:upgrade` used to leave a lint failure behind for that alone.
 *
 * The rules, matching Biome's JSON printer for the shapes these files hold: an object is always
 * expanded (one member per line — Biome keeps an object expanded once it was written expanded, and
 * every object here is); an array is printed on one line when its elements are all primitives and
 * the whole line, indent and trailing comma included, fits in `lineWidth`; otherwise one element per
 * line. `[]` and `{}` stay empty. Pure and dependency-free, like everything under `scripts/lib/`.
 */

export const JSON_LINE_WIDTH = 100

/** `value` as Biome would print it, with a trailing newline. */
export function formatJson(value, lineWidth = JSON_LINE_WIDTH) {
  return `${print(value, '', '', '', lineWidth)}\n`
}

const isPrimitive = v => v === null || typeof v !== 'object'

/** `prefix` is what precedes the value on its line (`"key": `); `suffix` what follows (`,`). */
function print(value, indent, prefix, suffix, lineWidth) {
  if (isPrimitive(value)) return JSON.stringify(value)
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.every(isPrimitive)) {
      const flat = `[${value.map(v => JSON.stringify(v)).join(', ')}]`
      if (indent.length + prefix.length + flat.length + suffix.length <= lineWidth) return flat
    }
    const items = value.map(
      (v, i) => `${inner}${print(v, inner, '', i < value.length - 1 ? ',' : '', lineWidth)}`
    )
    return `[\n${items.join(',\n')}\n${indent}]`
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return '{}'
  const members = entries.map(([k, v], i) => {
    const key = `${JSON.stringify(k)}: `
    const comma = i < entries.length - 1 ? ',' : ''
    return `${inner}${key}${print(v, inner, key, comma, lineWidth)}`
  })
  return `{\n${members.join(',\n')}\n${indent}}`
}
