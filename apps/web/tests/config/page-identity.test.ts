import { describe, expect, it } from 'vitest'
import { applyPageIdentity, pageIdentity } from '../../../../scripts/lib/page-identity.mjs'

const toml = (vars: string) =>
  `name = "front-desk"\n\n[vars]\n${vars}\n\n[assets]\nbinding = "ASSETS"\n`

const HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Rocketflare</title>
    <meta name="description" content="Rocketflare" />
    <meta name="theme-color" content="#974a37" />
  </head>
  <body><div id="root"></div></body>
</html>
`

describe('the page identity a toml declares', () => {
  it('takes the title from APP_NAME and the description from APP_TAGLINE', () => {
    const vars = 'APP_NAME = "Front Desk"\nAPP_TAGLINE = "Rooms, guests, done."'
    expect(pageIdentity(toml(vars))).toEqual({
      title: 'Front Desk',
      description: 'Rooms, guests, done.',
    })
  })

  it('describes the page by its name when there is no tagline, or a blank one', () => {
    const byName = { title: 'Front Desk', description: 'Front Desk' }
    expect(pageIdentity(toml('APP_NAME = "Front Desk"'))).toEqual(byName)
    expect(pageIdentity(toml('APP_NAME = "Front Desk"\nAPP_TAGLINE = "  "'))).toEqual(byName)
  })

  it('declares nothing without a name, so the page keeps what is written in it', () => {
    expect(pageIdentity(toml('APP_TAGLINE = "Rooms, guests, done."'))).toBeNull()
    expect(pageIdentity(toml('APP_NAME = ""'))).toBeNull()
    expect(pageIdentity(toml('APP_NAME = "   "'))).toBeNull()
    expect(pageIdentity(toml('APP_NAME = 42'))).toBeNull()
    expect(pageIdentity('name = "front-desk"\n')).toBeNull()
  })

  it('names the file and the line when the toml does not parse', () => {
    expect(() => pageIdentity('[vars\nAPP_NAME = "Front Desk"')).toThrow(/wrangler\.toml.*line 1/)
  })
})

describe('the page carries the identity', () => {
  it('writes the title and the description, and leaves the rest of the page alone', () => {
    const out = applyPageIdentity(HTML, {
      title: 'Front Desk',
      description: 'Rooms, guests, done.',
    })
    expect(out).toBe(
      HTML.replace('<title>Rocketflare</title>', '<title>Front Desk</title>').replace(
        'content="Rocketflare"',
        'content="Rooms, guests, done."'
      )
    )
  })

  it('returns the page untouched when there is no identity', () => {
    expect(applyPageIdentity(HTML, null)).toBe(HTML)
  })

  it('escapes what HTML would read as markup', () => {
    const out = applyPageIdentity(HTML, {
      title: 'R&D <Labs>',
      description: 'The "front" desk & more',
    })
    expect(out).toContain('<title>R&amp;D &lt;Labs&gt;</title>')
    expect(out).toContain('content="The &quot;front&quot; desk &amp; more"')
  })

  it('keeps a `$` in a value literal', () => {
    const out = applyPageIdentity(HTML, { title: 'Cash $& Carry $1', description: 'Save $$ now' })
    expect(out).toContain('<title>Cash $&amp; Carry $1</title>')
    expect(out).toContain('content="Save $$ now"')
  })

  it('refuses a page with no <title> to fill', () => {
    const untitled = HTML.replace('<title>Rocketflare</title>', '')
    expect(() =>
      applyPageIdentity(untitled, { title: 'Front Desk', description: 'Front Desk' })
    ).toThrow(/no <title>/)
  })

  it('says which element is wrong when the description has no content to fill', () => {
    const empty = HTML.replace(' content="Rocketflare"', '')
    expect(() =>
      applyPageIdentity(empty, { title: 'Front Desk', description: 'Front Desk' })
    ).toThrow(/description.*content/)
  })

  it('fills the elements however they are written', () => {
    const rewritten = HTML.replace(
      '<title>Rocketflare</title>',
      '<title lang="en">Old</title>'
    ).replace(
      '<meta name="description" content="Rocketflare" />',
      "<meta content='Old' name='description'>"
    )
    const out = applyPageIdentity(rewritten, {
      title: 'Front Desk',
      description: "The team's desk",
    })
    expect(out).toContain('<title lang="en">Front Desk</title>')
    expect(out).toContain(`<meta content="The team's desk" name='description'>`)
  })

  it('leaves a commented-out element alone and fills the live one', () => {
    const commented = HTML.replace(
      '<title>Rocketflare</title>',
      '<!-- <title>Old</title> <meta name="description" content="Old" /> -->\n    <title>Rocketflare</title>'
    )
    const out = applyPageIdentity(commented, { title: 'Front Desk', description: 'Rooms.' })
    expect(out).toContain('<!-- <title>Old</title> <meta name="description" content="Old" /> -->')
    expect(out).toContain('<title>Front Desk</title>')
    expect(out).toContain('<meta name="description" content="Rooms." />')
  })

  it('writes the title alone when the page has no description to fill', () => {
    const bare = HTML.replace('    <meta name="description" content="Rocketflare" />\n', '')
    const out = applyPageIdentity(bare, { title: 'Front Desk', description: 'Front Desk' })
    expect(out).toBe(bare.replace('<title>Rocketflare</title>', '<title>Front Desk</title>'))
  })
})
