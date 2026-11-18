/**
 * The Knowledge page's Facts view (`/documents?view=facts`, D43): every entity the reader may see a
 * current fact about — name, type, how many facts, how many need a look — browsable, not a queue.
 * The left column filters by entity type, "Needs a look" and the kind of source the facts came
 * from; a name box searches entity names and aliases; the list pages. Each row opens the entity
 * page, where "Is this still right?" stays inline on the fact. Counts come from the server over
 * VISIBLE facts only (`GET /api/knowledge/entities`).
 *
 * The URL is the state: `?ftype=` / `?fsource=` (repeatable), `?needs=1`, `?fq=`, `?fpage=` — named
 * apart from the other views' params so they never collide.
 */
import { CubeIcon, FunnelIcon } from '@heroicons/react/24/outline'
import { entityPath, type KnowledgeFacetValue } from '@rocketflare/shared/ai/knowledge-facts'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  EmptyState,
  PaginationControls,
  SearchInput,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useKnowledgeEntities } from '@/ui/hooks/useKnowledge'
import { formatDate } from '@/ui/lib/format'

/** The URL params this view owns. */
export const FACTS_VIEW_PARAMS = ['ftype', 'fsource', 'needs', 'fq', 'fpage'] as const

const PAGE_SIZE = 25
const LEGEND = 'text-xs font-semibold uppercase tracking-wide text-muted mb-1.5'

export function FactsBrowser() {
  const [params, setParams] = useSearchParams()
  const types = params.getAll('ftype').filter(Boolean)
  const sourceKinds = params.getAll('fsource').filter(Boolean)
  const needsLook = params.get('needs') === '1'
  const q = params.get('fq') ?? ''
  const page = Math.max(1, Number(params.get('fpage') ?? 1) || 1)
  const [open, setOpen] = useState(false)

  const list = useKnowledgeEntities({ page, pageSize: PAGE_SIZE, types, sourceKinds, needsLook, q })
  const update = (edit: (next: URLSearchParams) => void, keepPage = false) =>
    setParams(
      p => {
        const next = new URLSearchParams(p)
        edit(next)
        if (!keepPage) next.delete('fpage')
        return next
      },
      { replace: true }
    )
  const toggle = (name: 'ftype' | 'fsource', value: string, on: boolean) =>
    update(next => {
      const kept = next.getAll(name).filter(v => v !== value)
      next.delete(name)
      for (const v of on ? [...kept, value] : kept) next.append(name, v)
    })
  const active = types.length + sourceKinds.length + (needsLook ? 1 : 0) + (q ? 1 : 0)
  const clear = () =>
    update(next => {
      for (const name of FACTS_VIEW_PARAMS) next.delete(name)
    })

  const items = list.data?.items ?? []
  const facets = list.data?.facets

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-4 items-start">
      <aside aria-label="Fact filters">
        <button
          type="button"
          className="btn btn-sm w-full gap-1.5 lg:hidden"
          aria-expanded={open}
          aria-controls="facts-filters-panel"
          onClick={() => setOpen(o => !o)}
        >
          <FunnelIcon className="w-4 h-4" aria-hidden="true" />
          {open ? 'Hide filters' : 'Filters'}
          {active > 0 && <span className="badge badge-primary badge-sm">{active}</span>}
        </button>
        <div id="facts-filters-panel" className={open ? 'mt-3 lg:mt-0' : 'hidden lg:block'}>
          <SectionPanel
            title={
              <span className="inline-flex items-center gap-1.5">
                <FunnelIcon className="w-4 h-4 text-muted" aria-hidden="true" />
                Filters
              </span>
            }
            actions={
              active > 0 ? (
                <button type="button" className="btn btn-ghost btn-xs" onClick={clear}>
                  Clear all
                </button>
              ) : undefined
            }
          >
            <div className="space-y-5">
              <fieldset>
                <legend className={LEGEND}>State</legend>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={needsLook}
                    onChange={e =>
                      update(next => {
                        if (e.target.checked) next.set('needs', '1')
                        else next.delete('needs')
                      })
                    }
                  />
                  Needs a look
                </label>
              </fieldset>
              <FacetGroup
                legend="Type"
                values={withSelected(facets?.types ?? [], types)}
                selected={types}
                onToggle={(v, on) => toggle('ftype', v, on)}
              />
              <FacetGroup
                legend="Source"
                values={withSelected(facets?.sourceKinds ?? [], sourceKinds)}
                selected={sourceKinds}
                onToggle={(v, on) => toggle('fsource', v, on)}
              />
            </div>
          </SectionPanel>
        </div>
      </aside>

      <SectionPanel
        flush
        title="Entities"
        description="Everything the knowledge base has read facts about. Open one to see its facts and where each came from."
        actions={
          <SearchInput
            value={q}
            onChange={value =>
              update(next => {
                if (value.trim()) next.set('fq', value)
                else next.delete('fq')
              })
            }
            placeholder="Search by name"
            aria-label="Search entities by name"
            size="sm"
          />
        }
      >
        {list.isLoading ? (
          <div className="p-4">
            <SkeletonRows rows={4} />
          </div>
        ) : list.isError ? (
          <p className="p-4 text-sm text-error" role="alert">
            Facts could not be loaded.
          </p>
        ) : items.length === 0 ? (
          <EmptyState
            icon={CubeIcon}
            size="sm"
            message={active > 0 ? 'No entities match these filters' : 'No facts yet'}
            description={
              active > 0
                ? undefined
                : 'Facts appear here as documents are indexed and read for the entity types this workspace tracks.'
            }
            action={
              active > 0 ? (
                <button type="button" className="btn btn-sm" onClick={clear}>
                  Clear filters
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table" aria-label="Entities">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th className="text-right">Facts</th>
                  <th>Needs a look</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={`${item.entity.kind}:${item.entity.type}:${item.entity.id}`}>
                    <td>
                      <Link
                        to={entityPath(item.entity.type, item.entity.id)}
                        className="link link-primary font-medium"
                      >
                        {item.entity.name}
                      </Link>
                    </td>
                    <td>
                      <span className="badge badge-ghost badge-sm">{item.entity.typeLabel}</span>
                    </td>
                    <td className="text-right tabular-nums">{item.facts}</td>
                    <td>
                      {item.needsLook > 0 ? (
                        <span className="status-badge" data-status="awaiting-review">
                          {item.needsLook}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="text-sm text-secondary">{formatDate(item.lastObservedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data && (
          <div className="px-5 pb-4">
            <PaginationControls
              pagination={list.data.pagination}
              onPageChange={next =>
                update(p => {
                  if (next > 1) p.set('fpage', String(next))
                  else p.delete('fpage')
                }, true)
              }
              isLoading={list.isFetching}
            />
          </div>
        )}
      </SectionPanel>
    </div>
  )
}

/** The facet's values, plus any value the URL holds that it no longer lists (so it can be cleared). */
function withSelected(values: KnowledgeFacetValue[], selected: string[]): KnowledgeFacetValue[] {
  const missing = selected
    .filter(v => !values.some(f => f.value === v))
    .map(v => ({ value: v, label: v, count: 0 }))
  return [...values, ...missing]
}

function FacetGroup({
  legend,
  values,
  selected,
  onToggle,
}: {
  legend: string
  values: KnowledgeFacetValue[]
  selected: string[]
  onToggle: (value: string, on: boolean) => void
}) {
  if (values.length === 0) return null
  return (
    <fieldset className="space-y-1">
      <legend className={LEGEND}>{legend}</legend>
      {values.map(v => (
        <label key={v.value} className="flex items-center gap-2 text-sm cursor-pointer min-w-0">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={selected.includes(v.value)}
            onChange={e => onToggle(v.value, e.target.checked)}
          />
          <span className="truncate flex-1">{v.label}</span>
          <span className="text-xs text-muted tabular-nums">{v.count}</span>
        </label>
      ))}
    </fieldset>
  )
}
