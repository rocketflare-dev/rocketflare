/**
 * Home's "what needs doing" section: the cards installed plugins contribute (`UiPlugin.homeCards`).
 * `pages/Home.tsx` renders it above the quick links, so Home itself never names a plugin.
 *
 * Each card is isolated like a header item (`PluginHeaderSlot`): its own `Suspense` (a lazy chunk
 * still loading renders nothing) and its own error boundary (a throw renders nothing and is
 * logged), so one plugin's broken card never breaks Home or another plugin's card. A card with
 * nothing to ask of the reader renders `null`; the section brings no chrome of its own, so an
 * empty card leaves nothing behind, and with no card passing its guard the section is absent.
 */
import { Suspense } from 'react'
import type { AnyUiPlugin, PluginHomeCard } from '@/plugins/types'
import { useNavGuard } from '@/ui/hooks/useNavGuard'
import { ErrorBoundary } from './ErrorBoundary'

export interface PlacedHomeCard extends PluginHomeCard {
  pluginId: string
  /** `<plugin id>:<card id>` — the React key. */
  key: string
}

/** Every plugin's cards in a deterministic order: `order` (default 0), plugin id, card id. Pure. */
export function pluginHomeCards(
  plugins: readonly Pick<AnyUiPlugin, 'shared' | 'homeCards'>[]
): PlacedHomeCard[] {
  return plugins
    .flatMap(p =>
      (p.homeCards ?? []).map(card => ({
        ...card,
        pluginId: p.shared.id,
        key: `${p.shared.id}:${card.id}`,
      }))
    )
    .sort(
      (a, b) =>
        (a.order ?? 0) - (b.order ?? 0) ||
        a.pluginId.localeCompare(b.pluginId) ||
        a.id.localeCompare(b.id)
    )
}

export interface PluginHomeCardsProps {
  plugins: readonly Pick<AnyUiPlugin, 'shared' | 'homeCards'>[]
}

export function PluginHomeCards({ plugins }: PluginHomeCardsProps) {
  const canAccess = useNavGuard()
  const cards = pluginHomeCards(plugins).filter(card => canAccess(card.guard))
  if (cards.length === 0) return null
  return (
    <section aria-label="What needs doing" className="grid gap-4 mb-4" data-plugin-home-cards="">
      {cards.map(card => (
        <ErrorBoundary
          key={card.key}
          fallback={() => null}
          onError={(error, info) =>
            console.error(`[plugin home card] ${card.key} failed`, error, info.componentStack)
          }
        >
          <Suspense fallback={null}>
            <card.Component />
          </Suspense>
        </ErrorBoundary>
      ))}
    </section>
  )
}
