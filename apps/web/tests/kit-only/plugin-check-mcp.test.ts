/**
 * `pnpm plugin check` over a plugin's MCP surface (`scripts/lib/plugin-lib.mjs`), on fixture
 * sources: the tool names it reads out of `defineTool` calls, the problems it reports, and the
 * mounts it refuses on the paths the MCP server owns. Kit tooling, so kit-only; the host half is
 * `tests/config/mcp-plugin-seam.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  declaredTools,
  pluginManifestProblems,
  reservedMountPaths,
  stringConstants,
  toolProblems,
} from '../../../../scripts/lib/plugin-lib.mjs'

describe('plugin check — tools', () => {
  const src = `
    const NOTES_TOOL = 'gamma_notes'
    export const tool = (ctx) => defineTool({
      name: NOTES_TOOL,
      description: 'Lists the notes. ' + "Says when there are none.",
      schema: z.object({}),
      mcp: { title: 'Gamma notes' },
      async handler() { return call(fn(1), 'x)') },
    })
    // defineTool({ name: 'commented_out' })
    export const other = defineTool<In>({ name: 'gamma_other', description: \`Rocketflare data\` })
  `

  it('reads names (literal or constant), titles and descriptions from defineTool calls', () => {
    expect(declaredTools(src, stringConstants(src))).toEqual([
      {
        name: 'gamma_notes',
        title: 'Gamma notes',
        description: 'Lists the notes. Says when there are none.',
      },
      { name: 'gamma_other', title: null, description: 'Rocketflare data' },
    ])
    // A name no static read can resolve is left to the runtime check, not guessed.
    expect(declaredTools('defineTool({ name: built.name })')[0]?.name).toBeNull()
    // So is a template literal that interpolates — directly or through a constant.
    // (`$` + `{` spelled apart so these stay source text, not interpolations.)
    const $ = '$'
    const templated = `const PREFIX = \`x_\`\nconst N = \`${$}{PREFIX}load\`\n`
    const interpolated = `defineTool({ name: \`${$}{PREFIX}${$}{name}\` })`
    expect(declaredTools(interpolated)[0]?.name).toBeNull()
    expect(
      declaredTools(`${templated}defineTool({ name: N })`, stringConstants(templated))[0]?.name
    ).toBeNull()
    expect(stringConstants(templated).get('PREFIX')).toBe('x_')
    expect(
      toolProblems([
        {
          pluginId: 'x',
          file: 'f.ts',
          tools: declaredTools(interpolated),
        },
      ])
    ).toEqual([])
  })

  // The kit's name built from parts, as the check builds it: the rename leaves both alone.
  const KIT_NAME = ['Rocket', 'flare'].join('')

  it('fails a bad or colliding name and warns on the kit’s name in tool text', () => {
    const problems = toolProblems([
      {
        pluginId: 'gamma',
        file: 'g.ts',
        tools: [
          { name: 'gamma_notes', title: null, description: null },
          { name: 'get_document', title: null, description: null },
          { name: 'gamma.dots', title: null, description: null },
          {
            name: 'gamma_brand',
            title: `${KIT_NAME} helper`,
            description: `about ${KIT_NAME.toUpperCase()}`,
          },
        ],
      },
      {
        pluginId: 'delta',
        file: 'd.ts',
        tools: [{ name: 'gamma_notes', title: null, description: null }],
      },
    ])
    expect(problems.map(p => `${p.severity}:${p.pluginId}:${p.kind}:${p.tool}`)).toEqual([
      'fail:gamma:clash:get_document',
      'fail:gamma:name:gamma.dots',
      'warn:gamma:brand-title:gamma_brand',
      'warn:gamma:brand-description:gamma_brand',
      'fail:delta:clash:gamma_notes',
    ])
    expect(problems.find(p => p.kind === 'clash' && p.pluginId === 'delta')?.problem).toMatch(
      /'gamma' also declares/
    )
  })
})

describe('plugin check — reserved paths', () => {
  it('names a mount tuple on a reserved path, and never one in a comment or elsewhere', () => {
    expect(
      reservedMountPaths(`
        mounts: [['/mcp', router], ['/api/gamma', api]],
        publicMounts: [["/.well-known/oauth-authorization-server", doc]],
        // mounts: [['/oauth/token', x]]
        const label = '/mcp'
      `)
    ).toEqual(['/mcp', '/.well-known/oauth-authorization-server'])
  })

  it('fails a manifest apiPrefix on one', () => {
    const base = { id: 'gamma', version: '0.1.0', minKit: '0.8.0', repo: 'x' }
    const fields = (apiPrefixes: string[]) =>
      pluginManifestProblems({ ...base, apiPrefixes })
        .filter(p => p.field === 'apiPrefixes')
        .map(p => p.problem)
    expect(fields(['/cubejs-api'])).toEqual([])
    expect(fields(['/mcp', '/oauth/x'])).toEqual([
      expect.stringMatching(/\/mcp, which core reserves/),
      expect.stringMatching(/\/oauth\/x, which core reserves/),
    ])
  })
})
