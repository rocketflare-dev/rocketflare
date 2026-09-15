/**
 * Admin → Feature flags (D30). The two layers are shown separately on purpose.
 *
 * `availableInEnvironment` is CONFIG — `FEATURES_ENABLED` in that deployment's `[vars]`, moved by a
 * redeploy. When it is false the flag is off for everyone whatever its rollout says, so the page
 * says so rather than showing a percentage nobody is receiving.
 *
 * Everything else is ROLLOUT state, moved by a click here. A percentage is bucketed with the same
 * pure `featureBucket` the server uses, so the "would this organisation be in?" preview cannot
 * disagree with the answer a request gets.
 *
 * Overrides need more than one organisation to mean anything, so in single mode that whole section
 * is absent — matching the routes, which answer 404 `tenancy_mode_single`.
 */
import type {
  FeatureFlag,
  FeatureFlagState,
  FeatureRolloutUnit,
} from '@rocketflare/shared/features'
import { useState } from 'react'
import { EmptyState, SectionPanel, SkeletonRows, showToast } from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { useFeatureFlags, useUpdateFeatureFlag } from '@/ui/hooks/useFeatureFlags'
import { FlagOverrides } from './FlagOverrides'

const STATES: { value: FeatureFlagState; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Nobody, regardless of the percentage below.' },
  { value: 'on', label: 'On', hint: 'Everybody in every organisation.' },
  { value: 'rollout', label: 'Rollout', hint: 'The percentage below, chosen deterministically.' },
]

function FlagRow({ flag }: { flag: FeatureFlag }) {
  const { tenancyMode } = useAuth()
  const update = useUpdateFeatureFlag(flag.key)
  // Local state so dragging the range is smooth; the PATCH fires on release.
  const [percent, setPercent] = useState(flag.rolloutPercent)
  const single = tenancyMode === 'single'

  const save = (patch: Parameters<typeof update.mutate>[0]) =>
    update.mutate(patch, { onError: err => showToast((err as Error).message, 'error') })

  return (
    <div className="surface-panel p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{flag.label}</h3>
            <code className="text-xs text-muted">{flag.key}</code>
          </div>
          <p className="text-sm text-muted mt-1">{flag.description}</p>
        </div>
        {flag.overrideCount > 0 && (
          <span className="badge badge-sm tabular-nums whitespace-nowrap">
            {flag.overrideCount} override{flag.overrideCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {!flag.availableInEnvironment && (
        <div className="alert alert-warning text-sm">
          <span>
            Disabled in this environment. <code>{flag.key}</code> is not listed in{' '}
            <code>FEATURES_ENABLED</code>, so it is off for everyone — including you — whatever the
            rollout below says. Changing that is a configuration edit and a redeploy.
          </span>
        </div>
      )}

      <div>
        <div className="join">
          {STATES.map(state => (
            <button
              key={state.value}
              type="button"
              className={`btn btn-sm join-item ${flag.state === state.value ? 'btn-active' : ''}`}
              disabled={update.isPending}
              onClick={() => save({ state: state.value })}
            >
              {state.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted mt-1">{STATES.find(s => s.value === flag.state)?.hint}</p>
      </div>

      {flag.state === 'rollout' && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              value={percent}
              className="range range-sm flex-1"
              aria-label="Rollout percentage"
              onChange={e => setPercent(Number(e.target.value))}
              onMouseUp={() => save({ rolloutPercent: percent })}
              onKeyUp={() => save({ rolloutPercent: percent })}
            />
            <span className="tabular-nums w-12 text-right">{percent}%</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted">Counting</span>
            <select
              className="select select-sm select-bordered"
              value={flag.rolloutUnit}
              onChange={e => save({ rolloutUnit: e.target.value as FeatureRolloutUnit })}
            >
              <option value="tenant" disabled={single}>
                organisations
              </option>
              <option value="user">people</option>
            </select>
            {single && (
              <span className="text-xs text-muted">
                With one organisation a percentage of organisations is all-or-nothing, so only a
                rollout by people means anything here.
              </span>
            )}
          </div>
          <p className="text-xs text-muted">
            Raising the percentage only ever adds — nobody already inside a rollout falls out of it.
          </p>
        </div>
      )}

      {!single && <FlagOverrides flag={flag} />}
    </div>
  )
}

export default function FeatureFlags() {
  const { data, isLoading } = useFeatureFlags()
  const items = data?.items ?? []

  return (
    <SectionPanel
      title="Feature flags"
      description="What exists in this deployment, and who has it yet. Flag keys are code — add one in packages/shared."
    >
      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : items.length === 0 ? (
        <EmptyState
          message="No feature flags"
          description="Add a key to FEATURES in packages/shared/src/permissions.ts and its metadata in features.ts."
        />
      ) : (
        <div className="space-y-4">
          {items.map(flag => (
            <FlagRow key={flag.key} flag={flag} />
          ))}
        </div>
      )}
    </SectionPanel>
  )
}
