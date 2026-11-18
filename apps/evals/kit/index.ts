/**
 * The eval kit — everything a suite imports. See docs/EVALS.md for the how-to and the
 * `rf-evals` skill's `reference.md` for the judge catalogue.
 */
export { agentHarness } from './agent-target'
export { chatHarness } from './chat-target'
export {
  type Corpus,
  type CorpusDoc,
  checkCorpus,
  listCorpora,
  loadCorpus,
  type RetrievalCase,
} from './corpus'
export { loadDataset, parseDataset } from './dataset'
export { type DescribeCasesOptions, describeCases } from './describe'
export {
  EVAL_JUDGE_MODEL,
  EVAL_JUDGE_PROVIDER,
  EVAL_MODEL,
  EVAL_PROVIDER,
  evalSkipReason,
  skipEvals,
} from './env'
export { type CorpusWorld, corpusWorld } from './fixtures'
export { judgeHarness } from './judge-harness'
export {
  BudgetJudge,
  ContainsJudge,
  DecisionJudge,
  type EvalJudge,
  FaithfulnessJudge,
  MatchesJudge,
  ReferenceJudge,
  RubricJudge,
  SchemaJudge,
  TrajectoryJudge,
} from './judges'
export { EVAL_PROVIDERS, type EvalProviderName, evalEmbeddings } from './providers'
export { ContextPrecision, MRR, RecallAtK, retrievalHarness } from './retrieval'
export * from './scoring'
