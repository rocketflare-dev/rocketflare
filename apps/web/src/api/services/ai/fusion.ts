/**
 * The pure half of hybrid retrieval: Reciprocal Rank Fusion and the lexical query builder.
 *
 * **A leaf on purpose — it imports nothing.** `@/plugins/api` re-exports these, and a plugin calls
 * them; `retrieval.ts` imports `../access`, which reads the plugin barrel, so re-exporting them
 * from there put the barrel on `@/plugins/api`'s load path ahead of `createRouter`, and a second
 * installed plugin evaluated against a half-loaded API (`createRouter is not a function`).
 * `tests/config/plugin-api-load-order.test.ts` holds the line.
 */
/** The RRF constant from the original paper — the de-facto default. */
export const RRF_K = 60
/** Most words the lexical half ORs together; a pasted paragraph is not a keyword query. */
export const LEXICAL_MAX_TERMS = 32

/**
 * The lexical half's query: every distinct word of the input, OR-ed (`a | b | c`), for
 * `to_tsquery(SEARCH_TEXT_CONFIG, …)` to stem and stopword. ANY rather than ALL terms on purpose —
 * `websearch_to_tsquery` ANDs every word, so a natural-language question ("pedestrian segregation,
 * I want to know about it") matched only passages that also contained "want" and "know", i.e.
 * nothing, and the half that exists to catch exact terms the vectors miss went silent exactly when
 * a person typed a sentence. `ts_rank_cd` still ranks a passage with more (and denser) matching
 * terms first, so precision comes from the ranking, not from the filter. Only `\p{L}`/`\p{N}`
 * runs survive, so nothing a person types can be tsquery syntax. Null = no searchable word.
 */
export function anyTermTsquery(query: string): string | null {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
  return words.length ? words.slice(0, LEXICAL_MAX_TERMS).join(' | ') : null
}

/** "Retrieve wide, fuse narrow": how many candidates each signal contributes before fusion. */
export function candidatePoolSize(limit: number): number {
  return Math.min(Math.max(limit * 4, 50), 200)
}

export interface FusedItem<T> {
  item: T
  score: number
  rank: number
  denseRank: number | null
  lexicalRank: number | null
}

/** Reciprocal Rank Fusion of two ordered candidate lists (best first). Pure. */
export function fuseByRank<T>(
  dense: T[],
  lexical: T[],
  keyOf: (item: T) => string,
  k = RRF_K
): FusedItem<T>[] {
  return fuseDenseLegs([dense], lexical, keyOf, k)
}

/**
 * RRF over SEVERAL dense lists and one lexical list — one dense list per corpus whose vectors came
 * from a different embeddings model (a tenant's and the platform's), so each is ranked against the
 * query vector of ITS model and none is compared across models. An item's `denseRank` is its rank
 * in the dense list that holds it (the corpora are disjoint, so there is one). With one dense list
 * this IS `fuseByRank`.
 */
export function fuseDenseLegs<T>(
  denseLegs: T[][],
  lexical: T[],
  keyOf: (item: T) => string,
  k = RRF_K
): FusedItem<T>[] {
  const entries = new Map<string, FusedItem<T>>()
  const add = (list: T[], signal: 'denseRank' | 'lexicalRank') => {
    list.forEach((item, index) => {
      const rank = index + 1
      const key = keyOf(item)
      const entry = entries.get(key) ?? {
        item,
        score: 0,
        rank: 0,
        denseRank: null,
        lexicalRank: null,
      }
      entry.score += 1 / (k + rank)
      entry[signal] = rank
      entries.set(key, entry)
    })
  }
  for (const dense of denseLegs) add(dense, 'denseRank')
  add(lexical, 'lexicalRank')
  return [...entries.values()]
    .sort((a, b) => b.score - a.score || keyOf(a.item).localeCompare(keyOf(b.item)))
    .map((entry, index) => ({ ...entry, rank: index + 1 }))
}
