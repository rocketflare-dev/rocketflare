/**
 * `pnpm plugin check` over a plugin's own multipart routes (`uploadBodyProblems` in
 * `scripts/lib/plugin-lib.mjs`), on fixture sources. A route that reads a request body as a form
 * gets the host's 1 MB JSON cap unless the plugin declares where larger bodies may land, so a
 * file above 1 MB is a 413 whatever the route's own `bodyLimit` says. Kit tooling, so kit-only.
 */
import { describe, expect, it } from 'vitest'
import { uploadBodyProblems } from '../../../../scripts/lib/plugin-lib.mjs'

const route = `
  router.post('/upload', async c => {
    const body = await c.req.parseBody()
    return c.json({ ok: true, name: String(body.title) }, 201)
  })
`
const plugin = (extra: string) => `
  export const server = {
    shared,
    mount: { prefix: '/api/gamma', router },
    ${extra}
  }
`

describe('plugin check — multipart routes and the body cap', () => {
  it('warns when a route reads parseBody or formData and nothing lifts the 1 MB cap', () => {
    const problems = uploadBodyProblems('gamma', [
      { file: 'apps/web/src/plugins/gamma/server/routes.ts', text: route },
      { file: 'apps/web/src/plugins/gamma/server/index.ts', text: plugin('') },
    ])
    expect(problems).toEqual([
      expect.objectContaining({
        severity: 'warn',
        pluginId: 'gamma',
        file: 'apps/web/src/plugins/gamma/server/routes.ts',
        line: 3,
      }),
    ])
    expect(problems[0]?.problem).toMatch(/1 MB/)
    expect(problems[0]?.fix).toMatch(/uploadTargets/)

    const viaFormData = uploadBodyProblems('gamma', [
      { file: 'r.ts', text: 'async function h(c) { const f = await c.req.raw.formData() }' },
    ])
    expect(viaFormData).toHaveLength(1)
  })

  it('is quiet once the plugin declares uploadPaths, uploadLimits, uploadTargets or a public body limit', () => {
    for (const extra of [
      "uploadPaths: ['/api/gamma/upload'],",
      "uploadLimits: { '/api/gamma/upload': 10_000_000 },",
      'uploadTargets: [target],',
      "publicMounts: [{ prefix: '/gamma-forms', router, bodyLimitBytes: 5_000_000 }],",
    ]) {
      expect(
        uploadBodyProblems('gamma', [
          { file: 'routes.ts', text: route },
          { file: 'index.ts', text: plugin(extra) },
        ])
      ).toEqual([])
    }
  })

  it('reads code, not prose: a comment or a string naming parseBody is not a read', () => {
    expect(
      uploadBodyProblems('gamma', [
        {
          file: 'routes.ts',
          text: `
            // never c.req.parseBody() here
            /* await c.req.formData() */
            const note = 'c.req.parseBody()'
          `,
        },
        // …and a comment naming uploadPaths does not count as declaring it.
        { file: 'index.ts', text: `// uploadPaths: ['/api/gamma/x']\n${plugin('')}` },
      ])
    ).toEqual([])
    expect(
      uploadBodyProblems('gamma', [
        { file: 'routes.ts', text: route },
        { file: 'index.ts', text: `// uploadPaths: ['/api/gamma/x']\n${plugin('')}` },
      ])
    ).toHaveLength(1)
  })
})
