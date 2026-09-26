/** `pnpm eval`'s pure half (D33): reading a run report, baselines, and the regression compare. */
import { describe, expect, it } from 'vitest'
import {
  baselinesFrom,
  compareScores,
  extractCases,
  parseArgs,
  renderSummary,
  runHeader,
  scoreIndex,
  suiteId,
} from '../scripts/lib.mjs'

const assertion = (title: string, scores: Record<string, number | null>, status = 'passed') => ({
  title,
  status,
  failureMessages: [],
  meta: {
    eval: {
      avgScore:
        Object.values(scores).reduce((a: number, s) => a + (s ?? 0), 0) /
        Object.keys(scores).length,
      scores: Object.entries(scores).map(([name, score]) => ({
        name,
        score,
        metadata: { rationale: 'r' },
      })),
    },
    harness: {
      run: {
        usage: { model: 'claude-x', inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        timings: { totalMs: 1200 },
        artifacts: { promptKey: 'chat', promptHash: 'abc123' },
      },
    },
  },
})

const report = (cases: ReturnType<typeof assertion>[]) => ({
  testResults: [
    { name: '/repo/apps/evals/suites/chat/knowledge.eval.ts', assertionResults: cases },
  ],
})

describe('reading a run', () => {
  it('keys suites by path under suites/ and reads scores, usage and prompt hashes', () => {
    expect(suiteId('/x/apps/evals/suites/agents/summarize-text.eval.ts')).toBe(
      'agents-summarize-text'
    )
    const [c] = extractCases(report([assertion('refund-window', { Rubric: 1, Contains: 0.5 })]))
    expect(c).toMatchObject({
      suite: 'chat-knowledge',
      id: 'refund-window',
      avgScore: 0.75,
      scores: { Rubric: 1, Contains: 0.5 },
      model: 'claude-x',
      promptHash: 'abc123',
      totalMs: 1200,
    })
    const header = runHeader({ sha: 'abc', dirty: false, createdAt: 't', filters: [], cases: [c] })
    expect(header).toMatchObject({
      promptHashes: { chat: ['abc123'] },
      modelsObserved: ['claude-x'],
    })
    expect(renderSummary([c])).toContain('1/1 passed · mean score 0.75')
  })
})

describe('compareScores', () => {
  const base = scoreIndex(
    baselinesFrom(
      extractCases(
        report([
          assertion('refund-window', { Rubric: 1, Contains: 1 }),
          assertion('greeting', { Rubric: 1 }),
        ])
      ),
      { createdAt: 't', sha: 's', judgeModel: null }
    )
  )

  it('flags a drop past the threshold, a lost case, and a rise as an improvement', () => {
    const now = scoreIndex(
      extractCases(report([assertion('refund-window', { Rubric: 0.5, Contains: 1.0 })]))
    )
    const { regressions, improvements } = compareScores(base, now, 0.1)
    expect(regressions.map(r => [r.id, r.judge])).toEqual([
      ['refund-window', 'Rubric'],
      ['greeting', '(case)'],
    ])
    expect(improvements).toEqual([])
  })

  it('ignores drops within the threshold and suites the run did not include', () => {
    const now = scoreIndex(
      extractCases(
        report([
          assertion('refund-window', { Rubric: 0.95, Contains: 1 }),
          assertion('greeting', { Rubric: 1 }),
        ])
      )
    )
    expect(compareScores(base, now, 0.1).regressions).toEqual([])
    expect(compareScores({ other: {} }, now, 0.1).regressions).toEqual([])
  })
})

describe('parseArgs', () => {
  it('reads filters and flags, and --compare defaults to the baselines', () => {
    expect(parseArgs(['chat', '--model', 'm', '--compare'])).toMatchObject({
      filters: ['chat'],
      model: 'm',
      compare: 'baseline',
    })
    expect(parseArgs(['--compare', 'run.json', '--threshold', '0.2'])).toMatchObject({
      compare: 'run.json',
      threshold: 0.2,
    })
    expect(() => parseArgs(['--nope'])).toThrow('unknown flag --nope')
    expect(() => parseArgs(['--model'])).toThrow('--model needs a value')
  })
})
