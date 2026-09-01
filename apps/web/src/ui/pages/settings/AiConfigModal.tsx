/**
 * Add / edit one AI provider row (D17). Provider → preset chips (`presetsFor`) fill base URL +
 * model; fields follow the catalog's `needsApiKey` / `needsBaseUrl` / `supportsThinking` /
 * `supportsServiceTier`; the API key is write-only ("leave blank to keep"); the body is validated
 * with `upsertAiConfigRequestSchema` plus the three provider rules the schema alone cannot state.
 * "Test connection" posts the inline candidate (or the saved row when the key is kept) so a wrong
 * key is caught while the admin is still looking at the field.
 *
 * The label is the upsert key `(tenant, scope, label)`: it is read-only on edit — renaming would
 * create a second row rather than rename this one.
 */
import {
  type AiConfig,
  type AiProvider,
  type AiScope,
  DEFAULT_MODELS,
  type ProviderPreset,
  presetsFor,
  type TestAiConfigRequest,
  type TestAiConfigResponse,
  THINKING_ANSWER_HEADROOM,
  THINKING_MAX_BUDGET,
  THINKING_MIN_BUDGET,
  type UpsertAiConfigRequest,
  upsertAiConfigRequestSchema,
} from '@gmgo/shared/ai/config'
import { type FormEvent, useState } from 'react'
import { FieldError, fieldErrorFor, Modal } from '@/ui/components/shared'
import {
  type AiProviderInfo,
  providersForScope,
  useTestAiConfig,
  useUpsertAiConfig,
} from '@/ui/hooks/useAiConfig'

type Issue = { path: PropertyKey[]; message: string }

const SCOPE_LABEL: Record<AiScope, string> = { chat: 'chat', embeddings: 'embeddings' }

/** Per-provider vocabulary hint for the free-text tier (the server sends it verbatim). */
const TIER_HINT: Partial<Record<AiProvider, string>> = {
  anthropic: 'auto · standard_only',
  anthropic_compatible: 'default · flex · priority (Fireworks)',
}

export function TestVerdict({ result }: { result: TestAiConfigResponse }) {
  if (result.ok) {
    return (
      <p className="text-xs text-success" role="status">
        <span className="font-medium">Connected</span> in {result.latencyMs.toLocaleString()} ms ·{' '}
        <span className="font-mono">{result.model}</span>
      </p>
    )
  }
  return (
    <p className="text-xs text-error" role="status">
      <span className="font-medium">Connection failed</span>
      {result.error && <> · {result.error}</>}
      {result.code && <span className="text-muted"> ({result.code})</span>}
    </p>
  )
}

interface AiConfigModalProps {
  open: boolean
  onClose: () => void
  scope: AiScope
  providers: AiProviderInfo[]
  /** Editing this row; `null` = adding. */
  editing: AiConfig | null
  /** Whether the scope already has a default (a first row is always made default). */
  scopeHasDefault: boolean
}

export function AiConfigModal(props: AiConfigModalProps) {
  // Remount the form per open/target so state never leaks between rows.
  if (!props.open) return null
  return <AiConfigForm key={props.editing?.id ?? 'new'} {...props} />
}

function AiConfigForm({
  open,
  onClose,
  scope,
  providers,
  editing,
  scopeHasDefault,
}: AiConfigModalProps) {
  const offered = providersForScope(providers, scope)
  const upsert = useUpsertAiConfig()
  const test = useTestAiConfig()

  const [provider, setProvider] = useState<AiProvider>(
    editing?.provider ?? offered[0]?.id ?? 'anthropic'
  )
  const [label, setLabel] = useState(editing?.label ?? '')
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '')
  const [model, setModel] = useState(
    editing?.model ?? infoFor(offered, provider)?.defaultModel ?? ''
  )
  const [apiKey, setApiKey] = useState('')
  const [isDefault, setIsDefault] = useState(editing?.isDefault ?? !scopeHasDefault)
  const [thinkingEnabled, setThinkingEnabled] = useState(editing?.thinking.enabled ?? false)
  const [thinkingBudget, setThinkingBudget] = useState(
    editing?.thinking.budgetTokens ? String(editing.thinking.budgetTokens) : ''
  )
  const [serviceTier, setServiceTier] = useState(editing?.serviceTier ?? '')
  const [preset, setPreset] = useState<ProviderPreset | null>(null)
  const [issues, setIssues] = useState<Issue[]>()
  const [verdict, setVerdict] = useState<TestAiConfigResponse | null>(null)

  const info = infoFor(offered, provider)
  const presets = presetsFor(provider)
  const isChat = scope === 'chat'
  const providerSwitched = editing !== null && editing.provider !== provider
  const keepsKey = Boolean(editing?.hasCredential) && !providerSwitched
  const suggestions = info?.suggestedModels ?? []
  const defaultModel = DEFAULT_MODELS[provider]

  const changeProvider = (next: AiProvider) => {
    setProvider(next)
    setPreset(null)
    setBaseUrl('')
    setModel(infoFor(offered, next)?.defaultModel ?? DEFAULT_MODELS[next] ?? '')
    // Tiers and budgets are not portable between vendors: back to the safe defaults.
    setServiceTier('')
    setThinkingEnabled(false)
    setThinkingBudget('')
    setVerdict(null)
  }

  const applyPreset = (p: ProviderPreset) => {
    setPreset(p)
    setBaseUrl(p.baseUrl)
    setModel(p.defaultModel)
    if (!label) setLabel(p.name)
  }

  /** The request body as the contract expresses it; `undefined` fields are omitted. */
  const buildBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      scope,
      label: label.trim(),
      provider,
      model: model.trim(),
    }
    if (baseUrl.trim()) body.baseUrl = baseUrl.trim()
    if (apiKey) body.apiKey = apiKey
    if (isDefault) body.isDefault = true
    if (isChat && info?.supportsThinking) {
      body.thinking = thinkingEnabled
        ? { enabled: true, budgetTokens: Number.parseInt(thinkingBudget, 10) || undefined }
        : { enabled: false }
    }
    // Always sent when the provider has tiers, '' included — that is how an edit CLEARS one.
    if (isChat && info?.supportsServiceTier) body.serviceTier = serviceTier.trim()
    return body
  }

  const validate = (body: Record<string, unknown>): UpsertAiConfigRequest | null => {
    const parsed = upsertAiConfigRequestSchema.safeParse(body)
    const found: Issue[] = parsed.success ? [] : [...parsed.error.issues]
    if (info?.needsBaseUrl && !baseUrl.trim()) {
      found.push({ path: ['baseUrl'], message: `${info.name} requires a base URL` })
    }
    if (info?.needsApiKey && !apiKey && !keepsKey) {
      found.push({
        path: ['apiKey'],
        message: providerSwitched
          ? `The stored key belongs to ${editing?.provider}; enter one for ${info.name}`
          : 'An API key is required',
      })
    }
    if (isChat && thinkingEnabled && !(Number.parseInt(thinkingBudget, 10) > 0)) {
      found.push({ path: ['thinking'], message: 'Enter a token budget for extended thinking' })
    }
    if (found.length > 0) {
      setIssues(found)
      return null
    }
    setIssues(undefined)
    return parsed.success ? parsed.data : null
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const body = validate(buildBody())
    if (!body) return
    upsert.mutate(body, { onSuccess: onClose })
  }

  /** Inline candidate when we hold a key (or none is needed); the saved row when the key is kept. */
  const testRequest = (): TestAiConfigRequest | null => {
    if (!model.trim()) return null
    if (apiKey || !info?.needsApiKey) {
      return {
        scope,
        provider,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim(),
        apiKey: apiKey || undefined,
      }
    }
    if (editing && keepsKey) return { configId: editing.id }
    return null
  }
  const testable = testRequest()

  const runTest = () => {
    const body = testRequest()
    if (!body) return
    setVerdict(null)
    test.mutate(body, { onSuccess: setVerdict })
  }

  const err = (field: string) => fieldErrorFor(issues, field)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${editing ? 'Edit' : 'Add'} ${SCOPE_LABEL[scope]} provider`}
      className="max-w-xl"
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm btn-ghost mr-auto"
            onClick={runTest}
            disabled={!testable || test.isPending}
            title={testable ? undefined : 'Enter a model and an API key to test'}
          >
            {test.isPending ? 'Testing…' : 'Test connection'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="ai-config-form"
            className="btn btn-sm btn-primary"
            disabled={upsert.isPending}
          >
            {upsert.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add provider'}
          </button>
        </>
      }
    >
      <form id="ai-config-form" onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="ai-provider" className="label text-sm font-medium">
              Provider
            </label>
            <select
              id="ai-provider"
              className="select select-sm w-full"
              value={provider}
              onChange={e => changeProvider(e.target.value as AiProvider)}
            >
              {offered.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ai-label" className="label text-sm font-medium">
              Label
            </label>
            <input
              id="ai-label"
              className={`input input-sm w-full ${err('label') ? 'input-error' : ''}`}
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Production"
              readOnly={editing !== null}
              aria-invalid={err('label') ? true : undefined}
            />
            {editing ? (
              <p className="text-xs text-muted mt-1">
                The label identifies this entry; delete and re-add to rename it.
              </p>
            ) : (
              <FieldError message={err('label')} />
            )}
          </div>
        </div>

        {presets.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-1.5">Presets</p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Presets">
              {presets.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={`btn btn-xs ${preset?.id === p.id ? 'btn-primary' : 'btn-outline'}`}
                  aria-pressed={preset?.id === p.id}
                  onClick={() => applyPreset(p)}
                >
                  {p.name}
                </button>
              ))}
            </div>
            {preset?.note && <p className="text-xs text-muted mt-1.5">{preset.note}</p>}
          </div>
        )}

        {info?.needsBaseUrl && (
          <div>
            <label htmlFor="ai-base-url" className="label text-sm font-medium">
              Base URL
            </label>
            <input
              id="ai-base-url"
              type="url"
              className={`input input-sm w-full font-mono ${err('baseUrl') ? 'input-error' : ''}`}
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://…"
              aria-invalid={err('baseUrl') ? true : undefined}
            />
            <FieldError message={err('baseUrl')} />
          </div>
        )}

        {info?.needsApiKey && (
          <div>
            <label htmlFor="ai-api-key" className="label text-sm font-medium">
              API key{' '}
              {keepsKey && <span className="font-normal text-muted">(leave blank to keep)</span>}
            </label>
            <input
              id="ai-api-key"
              type="password"
              autoComplete="off"
              className={`input input-sm w-full font-mono ${err('apiKey') ? 'input-error' : ''}`}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={keepsKey ? '••••••••' : 'Paste the provider key'}
              aria-invalid={err('apiKey') ? true : undefined}
            />
            <FieldError message={err('apiKey')} />
          </div>
        )}

        <div>
          <label htmlFor="ai-model" className="label text-sm font-medium">
            Model
          </label>
          <input
            id="ai-model"
            list={suggestions.length > 0 ? 'ai-model-suggestions' : undefined}
            className={`input input-sm w-full font-mono ${err('model') ? 'input-error' : ''}`}
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder={defaultModel || 'model id as the endpoint names it'}
            aria-invalid={err('model') ? true : undefined}
          />
          {suggestions.length > 0 && (
            <datalist id="ai-model-suggestions">
              {suggestions.map(m => (
                <option key={m} value={m} />
              ))}
            </datalist>
          )}
          {defaultModel && (
            <p className="text-xs text-muted mt-1">
              Default for this provider: <span className="font-mono">{defaultModel}</span>
            </p>
          )}
          <FieldError message={err('model')} />
        </div>

        {isChat && info?.supportsThinking && (
          <div>
            <label className="label cursor-pointer justify-start gap-3">
              <input
                type="checkbox"
                className="toggle toggle-sm toggle-primary"
                checked={thinkingEnabled}
                onChange={e => setThinkingEnabled(e.target.checked)}
              />
              <span className="text-sm font-medium">Extended thinking</span>
            </label>
            {thinkingEnabled ? (
              <div className="mt-1.5">
                <label htmlFor="ai-thinking-budget" className="sr-only">
                  Thinking budget in tokens
                </label>
                <input
                  id="ai-thinking-budget"
                  type="number"
                  className={`input input-sm w-44 ${err('thinking') ? 'input-error' : ''}`}
                  min={THINKING_MIN_BUDGET}
                  max={THINKING_MAX_BUDGET}
                  step={256}
                  value={thinkingBudget}
                  onChange={e => setThinkingBudget(e.target.value)}
                  placeholder={`${THINKING_MIN_BUDGET}–${THINKING_MAX_BUDGET}`}
                  aria-invalid={err('thinking') ? true : undefined}
                />
                <p className="text-xs text-muted mt-1">
                  Reasoning tokens bill as output; keep at least {THINKING_ANSWER_HEADROOM} tokens
                  of answer room above the budget.
                </p>
                <FieldError message={err('thinking')} />
              </div>
            ) : (
              <p className="text-xs text-muted">
                Off by default and sent explicitly — a reasoning model would otherwise bill for
                thinking this surface discards.
              </p>
            )}
          </div>
        )}

        {isChat && info?.supportsServiceTier && (
          <div>
            <label htmlFor="ai-service-tier" className="label text-sm font-medium">
              Service tier <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id="ai-service-tier"
              className={`input input-sm w-full font-mono ${err('serviceTier') ? 'input-error' : ''}`}
              value={serviceTier}
              onChange={e => setServiceTier(e.target.value)}
              placeholder={TIER_HINT[provider] ?? 'provider default'}
              aria-invalid={err('serviceTier') ? true : undefined}
            />
            <p className="text-xs text-muted mt-1">
              Sent verbatim as <span className="font-mono">service_tier</span>; blank lets the
              provider decide.
            </p>
            <FieldError message={err('serviceTier')} />
          </div>
        )}

        <label className="label cursor-pointer justify-start gap-3">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={isDefault}
            disabled={editing?.isDefault || !scopeHasDefault}
            onChange={e => setIsDefault(e.target.checked)}
          />
          <span className="text-sm">
            Use as the default {SCOPE_LABEL[scope]} provider
            {!scopeHasDefault && (
              <span className="text-muted">
                {' '}
                (the first entry in a scope is always the default)
              </span>
            )}
          </span>
        </label>

        {verdict && <TestVerdict result={verdict} />}
      </form>
    </Modal>
  )
}

function infoFor(providers: AiProviderInfo[], id: AiProvider): AiProviderInfo | undefined {
  return providers.find(p => p.id === id)
}
