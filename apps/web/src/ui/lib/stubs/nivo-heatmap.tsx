/**
 * Build-time stand-in for `@nivo/heatmap` (D19). drizzle-cube's heat-map chart chunk imports
 * `ResponsiveHeatMap` by name from this optional peer; the kit does not ship @nivo (recharts is
 * the one chart library — docs/analysis/08 §4), and Rollup refuses a named import from Vite's
 * optional-peer placeholder. `vite.config.ts` aliases the package here so the lazily loaded
 * chart chunk still builds; picking the heat-map chart type renders this notice instead of a
 * chart. Install `@nivo/heatmap` and delete the alias to enable it.
 */
export function ResponsiveHeatMap(_props: Record<string, unknown>) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted">
      Heat-map charts need the optional <code className="mx-1">@nivo/heatmap</code> package.
    </div>
  )
}

export default ResponsiveHeatMap
