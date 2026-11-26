/**
 * The UI lint (`scripts/lib/ui-lint.mjs`): the checks behind `pnpm design:lint` and the guard's
 * UI review. Every case is a fixture string, so this suite says nothing about the app's own
 * screens and travels into every copy unchanged. The `config` project: no database.
 */
import { describe, expect, it } from 'vitest'
import {
  allowComments,
  isUiPath,
  lintCss,
  lintTsx,
  RULE_IDS,
  shadowProblems,
  splitFindings,
  UI_RULES,
} from '../../../../scripts/lib/ui-lint.mjs'

const rules = (findings: { rule: string }[]) => findings.map(f => f.rule)
const tsx = (body: string) => lintTsx(body, 'apps/web/src/ui/pages/X.tsx')
const css = (body: string, file = 'apps/web/src/ui/x.css') => lintCss(body, file)

describe('the rule table', () => {
  it('names a fix for every rule, and only two severities', () => {
    for (const id of RULE_IDS) {
      expect(UI_RULES[id].fix.length, id).toBeGreaterThan(10)
      expect(['ban', 'reflex']).toContain(UI_RULES[id].severity)
    }
  })

  it('reads the UI tree and every plugin UI, and nothing else', () => {
    expect(isUiPath('apps/web/src/ui/pages/Home.tsx')).toBe(true)
    expect(isUiPath('apps/web/src/ui/index.css')).toBe(true)
    expect(isUiPath('apps/web/src/plugins/approvals/ui/pages/List.tsx')).toBe(true)
    expect(isUiPath('apps/web/src/plugins/approvals/server.ts')).toBe(false)
    expect(isUiPath('apps/web/src/api/index.ts')).toBe(false)
    expect(isUiPath('apps/web/tests/ui/home.test.tsx')).toBe(false)
  })
})

describe('bans in TSX', () => {
  it('finds palette utilities, raw colours and gradient text', () => {
    expect(rules(tsx('<div className="bg-blue-50 p-2" />'))).toEqual(['palette-utility'])
    expect(rules(tsx('<div className="hover:text-white" />'))).toEqual(['palette-utility'])
    expect(rules(tsx("<div style={{ color: '#2563eb' }} />"))).toEqual(['raw-colour'])
    expect(rules(tsx('<div className="bg-[#fff]" />'))).toEqual(['raw-colour'])
    expect(rules(tsx("const c = 'rgb(0 0 0 / 0.4)'"))).toEqual(['raw-colour'])
    expect(rules(tsx('<h1 className="bg-clip-text text-transparent bg-linear-to-r" />'))).toEqual([
      'gradient-text',
    ])
  })

  it('leaves tokens, semantic classes and anchors alone', () => {
    expect(
      tsx('<div className="bg-base-200 text-primary border-[color:var(--border-subtle)]" />')
    ).toEqual([])
    expect(tsx('<a href="#main">Skip</a>')).toEqual([])
    expect(tsx("const mix = 'color-mix(in srgb, var(--color-primary) 8%, transparent)'")).toEqual(
      []
    )
  })

  it('finds a border and a shadow together, and a one-sided stripe on a rounded box', () => {
    expect(rules(tsx('<div className="border rounded-lg shadow-md" />'))).toEqual([
      'border-and-shadow',
    ])
    expect(tsx('<div className="border-0 shadow-md" />')).toEqual([])
    expect(tsx('<div className="border shadow-none" />')).toEqual([])
    expect(rules(tsx('<section className="surface-panel border-l-4 border-l-warning" />'))).toEqual(
      ['side-stripe']
    )
    expect(tsx('<td className="border-l-2" />')).toEqual([])
  })

  it('finds glows, hard shadows and tiny type', () => {
    expect(rules(tsx('<div className="shadow-primary/40" />'))).toEqual(['glow-shadow'])
    expect(rules(tsx('<div className="shadow-[0_0_24px_rgba(0,0,0,.2)]" />'))).toContain(
      'glow-shadow'
    )
    expect(rules(tsx('<div className="shadow-[4px_4px_0_var(--x)]" />'))).toEqual(['hard-shadow'])
    expect(rules(tsx('<span className="text-[10px]" />'))).toEqual(['tiny-type'])
    expect(rules(tsx('<span className="text-[0.65rem]" />'))).toEqual(['tiny-type'])
    expect(rules(tsx('<text fontSize={9}>x</text>'))).toEqual(['tiny-type'])
    // The floor is text-xs, 12px: 11px and 0.6875rem (DaisyUI's xs step) are under it.
    expect(rules(tsx('<span className="text-[11px]" />'))).toEqual(['tiny-type'])
    expect(rules(tsx('<span className="text-[0.6875rem]" />'))).toEqual(['tiny-type'])
    expect(rules(tsx('<text fontSize={11}>x</text>'))).toEqual(['tiny-type'])
    expect(tsx('<span className="text-[12px] text-xs" />')).toEqual([])
    // DaisyUI's xs controls are lifted to 12px in ui/index.css, so the class itself is fine.
    expect(tsx('<button className="btn btn-xs">Go</button>')).toEqual([])
    expect(tsx('<span className="badge badge-xs">3</span>')).toEqual([])
  })

  it('finds an emoji or a glyph used as an icon, but not an arrow in copy or a comment', () => {
    expect(rules(tsx('<span>🚀 Launch</span>'))).toEqual(['emoji-icon'])
    expect(rules(tsx('<span>✓ Done</span>'))).toEqual(['emoji-icon'])
    expect(tsx('<a>Open →</a>')).toEqual([])
    expect(tsx('// ✓ collapsed row\nconst x = 1')).toEqual([])
    expect(tsx('<small>© 2026</small>')).toEqual([])
  })

  it('finds a card inside a card, and not a card beside one', () => {
    const nested = `
      export function X() {
        return (
          <SectionPanel title="a">
            <div className="card p-4">inner</div>
          </SectionPanel>
        )
      }`
    expect(rules(tsx(nested))).toEqual(['nested-card'])
    const siblings = `
      export function X() {
        const [a] = useState<string>('')
        return (
          <div>
            <SectionPanel title="a">one</SectionPanel>
            <div className="surface-panel">two</div>
          </div>
        )
      }`
    expect(tsx(siblings)).toEqual([])
  })

  it('finds an uppercase eyebrow above a heading', () => {
    const eyebrow = `
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">Overview</p>
        <h1 className="text-2xl">Your workspace</h1>
      </div>`
    expect(rules(tsx(eyebrow))).toEqual(['eyebrow-label'])
    const legend = `
        <p className="text-xs uppercase tracking-wide text-muted">Organisation</p>
        <div className="text-lg">Acme</div>`
    expect(tsx(legend)).toEqual([])
  })

  it('finds a decorative grid or stripe background', () => {
    expect(
      rules(tsx('<div className="bg-[repeating-linear-gradient(45deg,var(--a),var(--b))]" />'))
    ).toEqual(['decorative-background'])
    expect(rules(tsx('<div className="bg-grid-slate" />'))).toContain('decorative-background')
  })
})

describe('reflexes in TSX', () => {
  it('finds a grid of mapped icon cards', () => {
    const grid = `
      <ul className="grid gap-2 sm:grid-cols-3">
        {links.map(link => (
          <li key={link.to}>
            <Link to={link.to} className="card p-4">
              <link.icon className="w-5 h-5" />
              {link.label}
            </Link>
          </li>
        ))}
      </ul>`
    expect(rules(tsx(grid))).toEqual(['identical-card-grid'])
    expect(splitFindings(tsx(grid)).bans).toEqual([])
  })

  it('finds a hero number, mono costume, a ring chart, a form modal and numbered sections', () => {
    expect(rules(tsx('<p className="text-5xl font-bold">1,204</p>'))).toEqual(['hero-metric'])
    expect(tsx('<h1 className="text-4xl">Welcome</h1>')).toEqual([])
    expect(tsx('<p className="text-4xl font-semibold">{name}</p>')).toEqual([])
    expect(rules(tsx('<span className="font-mono uppercase text-xs" />'))).toEqual([
      'decorative-mono',
    ])
    expect(rules(tsx('<div className="radial-progress" />'))).toEqual(['decorative-chart'])
    expect(rules(tsx('<h2 className="x">01 Setup</h2>'))).toEqual(['section-numbers'])
    const modal = `
      <Modal open title="New key">
        <input name="a" />
        <select name="b" />
        <textarea name="c" />
      </Modal>`
    expect(rules(tsx(modal))).toEqual(['reflex-modal'])
  })
})

describe('CSS', () => {
  it('allows raw colours in a token definition and in the token file, nowhere else', () => {
    expect(css('[data-theme="x"] { --surface-app: #f4f4f5; }')).toEqual([])
    expect(rules(css('.x { color: #18181b; }'))).toEqual(['raw-colour'])
    expect(css('.x { color: #18181b; }', 'apps/web/src/shared/theme-tokens.css')).toEqual([])
    expect(css('.x { color: var(--text-primary); }')).toEqual([])
  })

  it('finds the CSS forms of the bans', () => {
    expect(
      rules(css('.a { border: 1px solid var(--b); box-shadow: var(--shadow-popover); }'))
    ).toEqual(['border-and-shadow'])
    expect(css('.a { border: none; box-shadow: var(--shadow-panel); }')).toEqual([])
    expect(rules(css('.a { border-left: 4px solid red; border-radius: 8px; }'))).toContain(
      'side-stripe'
    )
    expect(rules(css('@layer components { .a { font-size: 10.5px; } }'))).toEqual(['tiny-type'])
    expect(rules(css('.a { font-size: 11px; }'))).toEqual(['tiny-type'])
    expect(css('.a { font-size: 0.75rem; }')).toEqual([])
    expect(rules(css('.a { box-shadow: 0 0 20px var(--color-primary); }'))).toEqual(['glow-shadow'])
    expect(rules(css(':root { --shadow-hard: 4px 4px 0 var(--ink); }'))).toEqual(['hard-shadow'])
    expect(rules(css('.a { -webkit-background-clip: text; }'))).toEqual(['gradient-text'])
    expect(
      rules(css('.a { background: repeating-linear-gradient(45deg, var(--a), var(--b)); }'))
    ).toEqual(['decorative-background'])
    expect(rules(css('.a { font-family: var(--font-mono); text-transform: uppercase; }'))).toEqual([
      'decorative-mono',
    ])
  })

  it('reads a focus ring as a ring, not a glow', () => {
    expect(shadowProblems('0 0 0 2px var(--focus-ring)')).toEqual([])
    expect(
      shadowProblems('0 6px 20px -6px rgb(24 24 27 / 0.14), 0 1px 2px rgb(0 0 0 / 0.06)')
    ).toEqual([])
    expect(shadowProblems('none')).toEqual([])
  })
})

describe('ui-allow', () => {
  it('silences one finding on the next line or the same line', () => {
    const above = `// ui-allow palette-utility: the third-party embed needs its own white
<div className="bg-white" />`
    expect(tsx(above)).toEqual([])
    const jsx =
      '<div className="bg-white" /> {/* ui-allow palette-utility: matches the embed frame */}'
    expect(tsx(jsx)).toEqual([])
    expect(
      css('/* ui-allow raw-colour: printed letterhead colour */\n.a { color: #123456; }')
    ).toEqual([])
  })

  it('silences only one finding, and only of the rule it names', () => {
    const two = `// ui-allow palette-utility: the embed
<div className="bg-white" style={{ color: '#fff' }} />`
    expect(rules(tsx(two))).toEqual(['raw-colour'])
  })

  it('makes an allow without a reason, or with an unknown rule, a ban of its own', () => {
    const bare = '// ui-allow palette-utility\n<div className="bg-white" />'
    expect(rules(tsx(bare)).sort()).toEqual(['palette-utility', 'ui-allow'])
    const unknown = '// ui-allow sparkle: because\n<div />'
    expect(rules(tsx(unknown))).toEqual(['ui-allow'])
    expect(allowComments(bare)).toEqual([{ line: 1, rule: 'palette-utility', reason: '' }])
  })
})
