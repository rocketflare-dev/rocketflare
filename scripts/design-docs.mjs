#!/usr/bin/env node
/**
 * The design pages: `docs/design/*.md` (+ `docs/design/diagrams/*.svg`) rendered into
 * `docs/design/html/` in the app's own tokens, with `docs/design/brand.css` layered over them.
 * `/rf-design` writes the markdown and runs this; the pages are committed with the design.
 *
 *   pnpm design:docs                  build the pages, print the path of its index.html
 *   pnpm design:docs --open           …and open it in the default browser
 *   pnpm design:docs --check          exit 1 when the pages are out of date with its inputs
 *   pnpm design:docs --contrast       the kit's contrast floors over the tokens + brand.css
 *   pnpm design:docs --apply-brand    write brand.css into theme-tokens.css, index.css, index.html
 *
 * `--root <dir>` points it at another checkout (the tests use a temporary one).
 * The rendering is `scripts/lib/design-docs-lib.mjs`; the contrast rules are
 * `scripts/lib/contrast.mjs`, shared with `apps/web/tests/ui/contrast.test.ts`.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyBrand } from './lib/brand.mjs'
import { checkTheme } from './lib/contrast.mjs'
import { designTokens, GENERATOR_META, planPages } from './lib/design-docs-lib.mjs'

const USAGE = `Usage: node scripts/design-docs.mjs [--open | --check | --contrast | --apply-brand] [--root <dir>]

  (no flag)       build docs/design/html/ from docs/design/*.md and print its index.html
  --open          build, then open index.html in the default browser
  --check         exit 1 if docs/design/html/ is out of date with its inputs (builds nothing)
  --contrast      check the tokens with docs/design/brand.css layered on; exit 1 on a failure
  --apply-brand   write docs/design/brand.css into the app's token files, in place
  --root <dir>    the checkout to work in (default: this one)`

const TOKENS_CSS = 'apps/web/src/shared/theme-tokens.css'
const INDEX_CSS = 'apps/web/src/ui/index.css'
const INDEX_HTML = 'apps/web/src/ui/index.html'
const LOGO = 'apps/web/src/ui/public/logo.svg'
const DESIGN = 'docs/design'
const BRAND = 'docs/design/brand.css'
const OUT = 'docs/design/html'

function parseArgs(argv) {
  const opts = { mode: 'build', open: false, root: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--open') opts.open = true
    else if (a === '--check') opts.mode = 'check'
    else if (a === '--contrast') opts.mode = 'contrast'
    else if (a === '--apply-brand') opts.mode = 'apply-brand'
    else if (a === '--root') opts.root = argv[++i]
    else if (a === '--help' || a === '-h') opts.mode = 'help'
    else throw new Error(`unknown argument: ${a}\n\n${USAGE}`)
  }
  return opts
}

const read = (root, rel) => readFileSync(path.join(root, rel), 'utf8')
const readIfExists = (root, rel) => (existsSync(path.join(root, rel)) ? read(root, rel) : null)

function appName(root) {
  try {
    const manifest = JSON.parse(read(root, '.rocketflare.json'))
    const name = manifest.app?.display ?? manifest.kit?.name ?? ''
    return name ? name[0].toUpperCase() + name.slice(1) : ''
  } catch {
    return ''
  }
}

/** Every `.svg` under `docs/design/diagrams/`, keyed `diagrams/<path>`. */
function readDiagrams(root) {
  const out = new Map()
  const dir = path.join(root, DESIGN, 'diagrams')
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.svg')) continue
    const abs = path.join(entry.parentPath, entry.name)
    out.set(
      `diagrams/${path.relative(dir, abs).split(path.sep).join('/')}`,
      readFileSync(abs, 'utf8')
    )
  }
  return out
}

function inputs(root) {
  const dir = path.join(root, DESIGN)
  const files = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
        .map(e => e.name)
    : []
  if (!files.length)
    throw new Error(`no ${DESIGN}/*.md to build from — /rf-design writes them (${dir})`)
  return {
    pages: files.map(file => ({ file, source: readFileSync(path.join(dir, file), 'utf8') })),
    diagrams: readDiagrams(root),
    tokensCss: read(root, TOKENS_CSS),
    indexCss: read(root, INDEX_CSS),
    brandCss: readIfExists(root, BRAND),
    logo: read(root, LOGO),
    appName: appName(root),
  }
}

/** Pages in the output folder this generator wrote earlier (they carry its meta tag). */
function generatedPages(outDir) {
  if (!existsSync(outDir)) return []
  return readdirSync(outDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.html'))
    .map(e => e.name)
    .filter(name => readFileSync(path.join(outDir, name), 'utf8').includes(GENERATOR_META))
}

function openInBrowser(file) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [file]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', file]]
        : ['xdg-open', [file]]
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => console.error(`Could not open a browser; open ${file} yourself.`))
  child.unref()
}

function build(root, { check, open }) {
  const plan = planPages(inputs(root))
  for (const w of plan.warnings) console.error(`warning: ${w}`)
  const outDir = path.join(root, OUT)
  const stale = generatedPages(outDir).filter(name => !plan.files.has(name))
  const index = path.join(outDir, 'index.html')
  if (check) {
    const outdated = [...plan.files]
      .filter(([name, content]) => readIfExists(outDir, name) !== content)
      .map(([name]) => name)
    if (!outdated.length && !stale.length) {
      console.log(`${OUT}/ is up to date.`)
      return 0
    }
    for (const name of outdated) console.error(`out of date: ${OUT}/${name}`)
    for (const name of stale) console.error(`stale page: ${OUT}/${name}`)
    console.error('Run `pnpm design:docs` to rebuild it.')
    return 1
  }
  mkdirSync(outDir, { recursive: true })
  for (const [name, content] of plan.files)
    if (readIfExists(outDir, name) !== content) writeFileSync(path.join(outDir, name), content)
  for (const name of stale) rmSync(path.join(outDir, name))
  console.log(index)
  if (open) openInBrowser(index)
  return 0
}

function contrast(root) {
  const brandCss = readIfExists(root, BRAND)
  const { themes, brand } = designTokens({
    tokensCss: read(root, TOKENS_CSS),
    indexCss: read(root, INDEX_CSS),
    brandCss,
  })
  console.log(
    brandCss
      ? `Contrast: the app's tokens with ${BRAND} layered on.`
      : `Contrast: the app's tokens (no ${BRAND}).`
  )
  for (const p of brand?.problems ?? []) console.error(`warning: brand.css: ${p}`)
  for (const u of brand?.unknown ?? [])
    console.error(`warning: brand.css: ${u} is not an app token; ignored`)
  for (const w of brand?.warnings ?? []) console.error(`warning: ${w}`)
  let failures = 0
  for (const kind of ['light', 'dark']) {
    const theme = themes[kind]
    if (!theme.name) {
      console.log(`${kind}: no theme named *-${kind}`)
      failures++
      continue
    }
    const result = checkTheme(theme.tokens)
    failures += result.failures
    if (!result.failures) {
      console.log(`${kind} (${theme.name}): all ${result.pairs.length} pairs pass`)
      continue
    }
    console.log(`${kind} (${theme.name}): ${result.failures} failing`)
    for (const p of result.pairs.filter(x => !x.ok))
      console.log(
        p.problem
          ? `  ${p.fg} on ${p.bg}: ${p.problem}`
          : `  ${p.fg} ${p.fgValue} on ${p.bg} ${p.bgValue}: ${p.ratio.toFixed(2)}:1, minimum ${p.floor}:1`
      )
    for (const e of result.equal.filter(x => !x.ok))
      console.log(`  ${e.a} ${e.aValue} must equal ${e.b} ${e.bValue}`)
  }
  return failures ? 1 : 0
}

function applyBrandFiles(root) {
  const brandCss = readIfExists(root, BRAND)
  if (brandCss === null) throw new Error(`no ${BRAND} to apply`)
  const r = applyBrand(
    {
      tokensCss: read(root, TOKENS_CSS),
      indexCss: read(root, INDEX_CSS),
      indexHtml: readIfExists(root, INDEX_HTML),
    },
    brandCss
  )
  for (const p of r.problems) console.error(`warning: brand.css: ${p}`)
  for (const u of r.unknown) console.error(`warning: brand.css: ${u} is not an app token; ignored`)
  for (const w of r.warnings) console.error(`warning: ${w}`)
  const writes = [
    [TOKENS_CSS, r.tokensCss],
    [INDEX_CSS, r.indexCss],
    [INDEX_HTML, r.indexHtml],
  ]
  for (const [rel, content] of writes) {
    if (content === null || content === readIfExists(root, rel)) continue
    writeFileSync(path.join(root, rel), content)
    console.log(`wrote ${rel}`)
  }
  console.log(
    `Applied ${r.applied.length} propert${r.applied.length === 1 ? 'y' : 'ies'}. ` +
      'Check them: `pnpm web test:ui` (tests/ui/contrast.test.ts).'
  )
  return 0
}

function main(argv) {
  const opts = parseArgs(argv)
  const root = path.resolve(
    opts.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  )
  if (opts.mode === 'help') {
    console.log(USAGE)
    return 0
  }
  if (opts.mode === 'contrast') return contrast(root)
  if (opts.mode === 'apply-brand') return applyBrandFiles(root)
  return build(root, { check: opts.mode === 'check', open: opts.open })
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  console.error(`design-docs: ${err.message}`)
  process.exitCode = 2
}
