/** Human output shows text from the server as inert text; `--json` stays the server's exact data. */
import chalk from 'chalk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runFeedbackList } from '../src/commands/feedback'
import { renderTraceTree } from '../src/commands/traces'
import { runWhoami } from '../src/commands/whoami'
import { createMemoryLogger } from '../src/utils/logger'
import { formatCell, neutralise, renderTable } from '../src/utils/output'
import {
  jsonResponse,
  mockFetch,
  TENANT_ID,
  TEST_KEY,
  tempStore,
  testContext,
  USER_ID,
} from './helpers'

const SERVER = 'http://server.test'
const WITH_ESCAPES = 'ok\u001b[2K\u001b[1Gsecond part'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

const noControls = (text: string) => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the characters under test
  expect(text).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\u007F-\u009F]/)
}

async function loggedInStore() {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({
    serverUrl: SERVER,
    apiKey: TEST_KEY,
    tenantId: TENANT_ID,
    tenantName: 'Acme',
  })
  return t.store
}

describe('neutralise', () => {
  it('removes C0, DEL and C1 and keeps newlines and tabs', () => {
    expect(neutralise('a\u0000b\u001bc\u007fd\u009be\tf\ng')).toBe('abcde\tf\ng')
  })
  it('treats a carriage return as the end of a line', () => {
    expect(neutralise('one\r\ntwo\rthree')).toBe('one\ntwo\nthree')
  })
  it('leaves ordinary and non-Latin text alone', () => {
    expect(neutralise('Zoë — 東京 ✓')).toBe('Zoë — 東京 ✓')
  })
})

describe('renderTable', () => {
  it('prints an emailed subject with terminal sequences as plain text', () => {
    const subject = 'Invoice\u001b]0;window title\u0007\u001b[2K\r\nlater text\u009b2J'
    const text = renderTable([{ subject }], [{ header: 'Subject', value: r => r.subject }])
    noControls(text)
    expect(text.split('\n')).toHaveLength(2)
    expect(text).toContain('Invoice')
    expect(text).toContain('later text')
  })

  it('never lets one cell start another row', () => {
    expect(formatCell('one\ntwo\tthree')).toBe('one two three')
  })

  it('covers objects and arrays', () => {
    noControls(formatCell({ note: 'a\u009bb' }))
    noControls(formatCell(['a\u001b[2Kb']))
  })

  describe('styled columns', () => {
    const before = chalk.level
    beforeEach(() => {
      chalk.level = 1
    })
    afterEach(() => {
      chalk.level = before
    })

    it('keeps the colour and pads on the unstyled width', () => {
      const rows = [{ state: 'up' }, { state: 'failing' }]
      const text = renderTable(rows, [
        {
          header: 'State',
          value: r => r.state,
          style: (t, r) => (r.state === 'up' ? chalk.green(t) : t),
        },
        { header: 'After', value: () => 'x' },
      ])
      const line = text.split('\n')[1] as string
      expect(line).toContain(chalk.green('up     '))
      expect(line).toContain('\u001b[')
      expect(text).toContain('failing  x')
    })

    it('never styles a value from the server into a control sequence', () => {
      const text = renderTable(
        [{ s: WITH_ESCAPES }],
        [{ header: 'S', value: r => r.s, style: t => chalk.red(t) }]
      )
      expect(text).toContain(chalk.red('ok[2K[1Gsecond part'))
    })
  })
})

describe('commands in human mode', () => {
  const feedbackBody = {
    items: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        target: 'message',
        targetId: '22222222-2222-4222-8222-222222222222',
        rating: -1,
        comment: WITH_ESCAPES,
        userId: USER_ID,
        traceId: null,
        createdAt: '2026-09-25T10:00:00.000Z',
        updatedAt: '2026-09-25T10:00:00.000Z',
      },
    ],
    pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
  }

  it('feedback list prints a comment without control bytes', async () => {
    const store = await loggedInStore()
    const api = mockFetch({ '/api/feedback': () => jsonResponse(feedbackBody) })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runFeedbackList(ctx)
    expect(out.content()).not.toContain('\u001b[2K')
    expect(out.content()).toContain('second part')
  })

  it('--json keeps the bytes as the server sent them', async () => {
    const store = await loggedInStore()
    const api = mockFetch({ '/api/feedback': () => jsonResponse(feedbackBody) })
    const { ctx, out } = await testContext({ store, fetch: api.fetch, json: true })
    await runFeedbackList(ctx)
    expect(JSON.parse(out.content()).items[0].comment).toBe(WITH_ESCAPES)
  })

  it('whoami prints a name and tenant without control bytes', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/me': () => jsonResponse({ email: 'a@example.com', name: WITH_ESCAPES }),
      '/api/tenant': () => jsonResponse({ id: TENANT_ID, name: `Acme\u009b2J\u001b]0;t\u0007` }),
    })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runWhoami(ctx)
    expect(out.content()).not.toContain('\u001b[2K')
    expect(out.content()).not.toContain('\u009b')
    expect(out.content()).not.toContain('\u0007')
  })

  it('traces show clips span content without control bytes', () => {
    const text = renderTraceTree({
      trace: {} as never,
      spans: [
        {
          spanId: 'a',
          parentSpanId: null,
          name: `tool\u009b2J`,
          kind: 'tool',
          status: 'error',
          statusMessage: 'bad\u001b[2K',
          model: null,
          durationMs: 1,
          inputTokens: null,
          outputTokens: null,
          attributes: {},
          content: { input: 'in\u001b]0;x\u0007', output: { value: 'out\u009b2J' } },
        } as never,
      ],
    })
    expect(text).not.toContain('\u009b')
    expect(text).not.toContain('\u001b]')
    expect(text).not.toContain('\u0007')
    expect(text).not.toContain('\u001b[2K')
  })

  it('a logged line drops control bytes, and keeps line breaks', () => {
    const log = createMemoryLogger()
    log.error('server said \u001b[2Knope\u009b2J')
    log.hint('line one\nline two')
    expect(log.lines.join('')).not.toContain('\u001b[2K')
    expect(log.lines.join('')).not.toContain('\u009b')
    expect(log.lines[1]).toContain('line one\nline two')
  })
})
