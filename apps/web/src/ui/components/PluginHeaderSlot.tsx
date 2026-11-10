/**
 * The top-bar items installed plugins contribute (`UiPlugin.header`). `App.tsx` renders one slot
 * per placement inside `Layout` — `center` as `headerCenter`, `end` at the head of `headerEnd` —
 * so `Layout` itself never names a plugin.
 *
 * Each item is isolated twice: its own `Suspense` (a lazy chunk still loading renders nothing,
 * never the whole header's spinner) and its own error boundary (a throw renders nothing and is
 * logged), so one plugin's broken header item never breaks the shell or another plugin's item.
 */
import { Suspense } from 'react'
import type { AnyUiPlugin, PluginHeaderItem, PluginHeaderPlacement } from '@/plugins/types'
import { useNavGuard } from '@/ui/hooks/useNavGuard'
import { ErrorBoundary } from './ErrorBoundary'

export interface PlacedHeaderItem extends PluginHeaderItem {
  pluginId: string
  /** `<plugin id>:<item id>` — the React key. */
  key: string
}

/**
 * Every plugin's items for one placement (an item with none is `end`), in a deterministic order:
 * `order` ascending (default 0), then plugin id, then item id. Pure.
 */
export function pluginHeaderItems(
  plugins: readonly Pick<AnyUiPlugin, 'shared' | 'header'>[],
  placement: PluginHeaderPlacement
): PlacedHeaderItem[] {
  return plugins
    .flatMap(p =>
      (p.header ?? []).map(item => ({
        ...item,
        pluginId: p.shared.id,
        key: `${p.shared.id}:${item.id}`,
      }))
    )
    .filter(item => (item.placement ?? 'end') === placement)
    .sort(
      (a, b) =>
        (a.order ?? 0) - (b.order ?? 0) ||
        a.pluginId.localeCompare(b.pluginId) ||
        a.id.localeCompare(b.id)
    )
}

export interface PluginHeaderSlotProps {
  plugins: readonly Pick<AnyUiPlugin, 'shared' | 'header'>[]
  placement: PluginHeaderPlacement
}

export function PluginHeaderSlot({ plugins, placement }: PluginHeaderSlotProps) {
  const canAccess = useNavGuard()
  const items = pluginHeaderItems(plugins, placement).filter(item => canAccess(item.guard))
  if (items.length === 0) return null
  return (
    <div
      className={`flex items-center gap-1.5 min-w-0 ${placement === 'center' ? 'flex-1 justify-center' : ''}`}
      data-plugin-header={placement}
    >
      {items.map(item => (
        <ErrorBoundary
          key={item.key}
          fallback={() => null}
          onError={(error, info) =>
            console.error(`[plugin header] ${item.key} failed`, error, info.componentStack)
          }
        >
          <Suspense fallback={null}>
            <item.Component />
          </Suspense>
        </ErrorBoundary>
      ))}
    </div>
  )
}
