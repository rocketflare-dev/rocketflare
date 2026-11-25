/**
 * Every corpus under `datasets/` is sound before any eval spends a token on it: answer keys name
 * documents that exist, quotes and passages are verbatim, conflicts pair real facts. A corpus that
 * drifted from its documents would score a regression that is not one.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkCorpus, listCorpora, loadCorpus, parseFrontMatter } from '../kit/corpus'

describe('corpora', () => {
  for (const name of listCorpora()) {
    it(`${name} is sound`, () => {
      const corpus = loadCorpus(name)
      expect(corpus.docs.length).toBeGreaterThan(0)
      expect(checkCorpus(corpus)).toEqual([])
    })
  }

  it('reads front matter and refuses a document without it', () => {
    const { meta, body } = parseFrontMatter(
      '---\ntitle: A: b\ndate: 2026-01-02\n---\n\n# Hi\n',
      'x'
    )
    expect(meta).toEqual({ title: 'A: b', date: '2026-01-02' })
    expect(body).toBe('# Hi')
    expect(() => parseFrontMatter('# no front matter', 'x.md')).toThrow(/x\.md: no front matter/)
  })

  it('finds a corpus at any depth and reports a passage that is not verbatim', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'corpus-'))
    const dir = path.join(root, 'kit-only', 'tiny')
    mkdirSync(path.join(dir, 'docs'), { recursive: true })
    writeFileSync(
      path.join(dir, 'docs', 'a.md'),
      '---\ntitle: A\ndate: 2026-01-02\norigin: upload\nsource: uploads\nkind: note\n---\nThe fee is £10.\n'
    )
    writeFileSync(
      path.join(dir, 'retrieval.jsonl'),
      '{"id":"q1","query":"fee","expected":[{"doc":"a","passage":"The fee is £12."}]}\n' +
        '{"id":"q2","query":"fee","expected":[{"doc":"b","passage":"x"}]}\n'
    )
    expect(listCorpora(root)).toEqual(['kit-only/tiny'])
    expect(checkCorpus(loadCorpus('kit-only/tiny', root))).toEqual([
      'retrieval q1: not verbatim in a: "The fee is £12."',
      'retrieval q2: no document "b"',
    ])
  })
})
