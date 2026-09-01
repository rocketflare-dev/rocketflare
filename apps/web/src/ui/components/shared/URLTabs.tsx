import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

export interface TabConfig {
  id: string
  label: string
  content: ReactNode
  icon?: ReactNode
  badge?: string | number
}

interface URLTabsProps {
  tabs: TabConfig[]
  defaultTab?: string
  /** Query parameter name (default `tab`) */
  param?: string
  className?: string
  /** Rendered at the end of the tab bar */
  actions?: ReactNode
}

/** Tabs whose active state lives in `?tab=`, so deep links and back/forward work. */
export function URLTabs({
  tabs,
  defaultTab,
  param = 'tab',
  className = '',
  actions,
}: URLTabsProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const activeId = searchParams.get(param) ?? defaultTab ?? tabs[0]?.id
  const active = tabs.find(t => t.id === activeId) ?? tabs[0]

  const selectTab = (id: string) => {
    const next = new URLSearchParams(searchParams)
    next.set(param, id)
    setSearchParams(next, { replace: true })
  }

  return (
    <div className={className}>
      <div className="flex items-center border-b border-[color:var(--border-default)] mb-6">
        <div role="tablist" className="tabs tabs-border flex-1">
          {tabs.map(tab => {
            const selected = tab.id === active?.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`tab gap-2 ${selected ? 'tab-active font-semibold' : ''}`}
                onClick={() => selectTab(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tab.badge !== undefined && <span className="badge badge-sm">{tab.badge}</span>}
              </button>
            )
          })}
        </div>
        {actions && <div className="shrink-0 pb-1">{actions}</div>}
      </div>
      <div role="tabpanel">{active?.content}</div>
    </div>
  )
}
