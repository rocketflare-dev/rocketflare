import { parseToml } from './toml-lite.mjs'

const trimmedOrNull = value => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** `{ title, description }` from a wrangler toml's `[vars]`, or null when it sets no `APP_NAME`. */
export function pageIdentity(tomlText) {
  let vars
  try {
    vars = parseToml(tomlText).vars ?? {}
  } catch (error) {
    throw new Error(`wrangler.toml does not parse, so the page has no title: ${error.message}`, {
      cause: error,
    })
  }
  const title = trimmedOrNull(vars.APP_NAME)
  if (!title) return null
  return { title, description: trimmedOrNull(vars.APP_TAGLINE) ?? title }
}

const escapeText = value =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const escapeAttribute = value => escapeText(value).replaceAll('"', '&quot;')

const COMMENT = /<!--[\s\S]*?-->/g
const TITLE = /(<title\b[^>]*>)[^<]*(<\/title>)/gi
const META = /<meta\b[^>]*>/gi
const NAMED_DESCRIPTION = /\bname\s*=\s*(["'])description\1/i
const CONTENT = /(\bcontent\s*=\s*)(?:"[^"]*"|'[^']*')/i

/** The first match of `pattern` that is not inside an HTML comment and that `accepts` its text. */
function liveMatch(html, pattern, accepts = () => true) {
  const comments = [...html.matchAll(COMMENT)].map(m => [m.index, m.index + m[0].length])
  for (const match of html.matchAll(pattern)) {
    const commented = comments.some(([start, end]) => match.index >= start && match.index < end)
    if (!commented && accepts(match[0])) return match
  }
  return null
}

const replaceMatch = (html, match, text) =>
  html.slice(0, match.index) + text + html.slice(match.index + match[0].length)

function withTitle(html, title) {
  const match = liveMatch(html, TITLE)
  if (!match) {
    throw new Error('index.html has no <title> to fill from APP_NAME: add an empty <title></title>')
  }
  return replaceMatch(html, match, match[1] + escapeText(title) + match[2])
}

function withDescription(html, description) {
  const match = liveMatch(html, META, tag => NAMED_DESCRIPTION.test(tag))
  if (!match) return html
  if (!CONTENT.test(match[0])) {
    throw new Error(
      'index.html: <meta name="description"> has no content attribute to fill from APP_TAGLINE'
    )
  }
  const tag = match[0].replace(CONTENT, (_, attr) => `${attr}"${escapeAttribute(description)}"`)
  return replaceMatch(html, match, tag)
}

/** `html` with its `<title>` and meta description set from `identity`; null leaves it as written. */
export function applyPageIdentity(html, identity) {
  if (!identity) return html
  return withDescription(withTitle(html, identity.title), identity.description)
}
