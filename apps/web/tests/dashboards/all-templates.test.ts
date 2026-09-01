/**
 * Structural invariants for every dashboard template (D19) — no database. Each assertion pins a
 * failure mode drizzle-cube handles SILENTLY (renders something wrong rather than throwing), so a
 * unit test is the only place it can be caught. `rows` is authoritative in `layoutMode: 'rows'`;
 * portlet x/y/w/h are what grid mode, the mobile stack and thumbnails read, so they must agree.
 * Additionally every `Cube.member` a portlet references must exist in `src/api/cubes/` — the
 * frozen-name contract. Ported from the source app's tests/dashboards/all-templates.test.ts.
 */
import type { DashboardConfig } from 'drizzle-cube/client'
import { describe, expect, it } from 'vitest'
import { allCubes } from '@/api/cubes'
import { DASHBOARD_TEMPLATES, getTemplate, listTemplates } from '@/dashboards'

const templates = Object.entries(DASHBOARD_TEMPLATES)
const CASES = templates.map(([id, t]) => [id, t.config] as const)

/** `Cube.member` → exists, from the registry (no compiler needed). */
const KNOWN_MEMBERS = new Set(
  allCubes.flatMap(c => [
    ...Object.keys(c.measures).map(m => `${c.name}.${m}`),
    ...Object.keys(c.dimensions).map(d => `${c.name}.${d}`),
  ])
)
const UNIVERSAL = '__universal_time__'

function membersOf(query: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ['measures', 'dimensions', 'segments'] as const) {
    for (const m of (query[key] as string[] | undefined) ?? []) out.push(m)
  }
  for (const td of (query.timeDimensions as Array<{ dimension: string }> | undefined) ?? []) {
    out.push(td.dimension)
  }
  for (const key of Object.keys((query.order as Record<string, unknown> | undefined) ?? {})) {
    out.push(key)
  }
  const walk = (filters: unknown[]) => {
    for (const f of filters as Array<Record<string, unknown>>) {
      if (Array.isArray(f.filters)) walk(f.filters)
      else if (typeof f.member === 'string') out.push(f.member)
    }
  }
  walk((query.filters as unknown[] | undefined) ?? [])
  return out
}

describe.each(CASES)('%s template', (id, config: DashboardConfig) => {
  const portlets = config.portlets ?? []
  const rows = config.rows ?? []
  const groups = config.groups ?? []

  it('uses rows layout with an explicit rows array', () => {
    expect(config.layoutMode, `${id} layoutMode`).toBe('rows')
    expect(rows.length, `${id} must declare rows`).toBeGreaterThan(0)
  })

  it('gives every row a full 12 columns', () => {
    for (const row of rows) {
      const total = row.columns.reduce((sum, c) => sum + c.w, 0)
      expect(total, `${id} row ${row.id} widths must total 12`).toBe(12)
    }
  })

  it('gives every row and group a unique id', () => {
    const rowIds = rows.map(r => r.id)
    expect(new Set(rowIds).size, `${id} duplicate row id`).toBe(rowIds.length)
    const groupIds = groups.map(g => g.id)
    expect(new Set(groupIds).size, `${id} duplicate group id`).toBe(groupIds.length)
  })

  it('resolves every row column to a real portlet or group', () => {
    const portletIds = new Set(portlets.map(p => p.id))
    const groupIds = new Set(groups.map(g => g.id))
    for (const row of rows) {
      for (const col of row.columns) {
        expect(
          Boolean(col.portletId) !== Boolean(col.groupId),
          `${id} row ${row.id}: exactly one of portletId/groupId`
        ).toBe(true)
        if (col.groupId) {
          expect(groupIds.has(col.groupId), `${id} unknown groupId ${col.groupId}`).toBe(true)
        } else {
          expect(
            portletIds.has(col.portletId as string),
            `${id} unknown portletId ${col.portletId}`
          ).toBe(true)
        }
      }
    }
  })

  it('resolves every group cell to a real portlet', () => {
    const portletIds = new Set(portlets.map(p => p.id))
    for (const group of groups) {
      expect(group.cells.length, `${id} group ${group.id} has no cells`).toBeGreaterThan(0)
      for (const cell of group.cells) {
        expect(cell.portletIds.length, `${id} group ${group.id} empty cell`).toBeGreaterThan(0)
        for (const pid of cell.portletIds) {
          expect(portletIds.has(pid), `${id} group ${group.id} unknown portlet ${pid}`).toBe(true)
        }
      }
    }
  })

  it('places every portlet exactly once across rows and groups', () => {
    const seen = new Map<string, number>()
    const bump = (pid: string) => seen.set(pid, (seen.get(pid) ?? 0) + 1)
    const groupById = new Map(groups.map(g => [g.id, g]))
    for (const row of rows) {
      for (const col of row.columns) {
        if (col.groupId) {
          for (const cell of groupById.get(col.groupId)?.cells ?? []) {
            for (const pid of cell.portletIds) bump(pid)
          }
        } else if (col.portletId) {
          bump(col.portletId)
        }
      }
    }
    for (const p of portlets) {
      expect(seen.get(p.id) ?? 0, `${id} portlet ${p.id} placement count`).toBe(1)
    }
    for (const [pid, count] of seen) {
      expect(count, `${id} portlet ${pid} referenced more than once`).toBe(1)
    }
  })

  it("keeps each portlet's grid coordinates in step with its row", () => {
    const groupById = new Map(groups.map(g => [g.id, g]))
    const expected = new Map<string, { x: number; y: number; w: number; h: number }>()
    let y = 0
    for (const row of rows) {
      let x = 0
      for (const col of row.columns) {
        if (col.groupId) {
          const cells = groupById.get(col.groupId)?.cells ?? []
          const n = cells.length
          const cellW = Math.max(1, Math.floor(col.w / n))
          cells.forEach((cell, i) => {
            const w = i === n - 1 ? col.w - cellW * (n - 1) : cellW
            const stack = cell.portletIds.length
            const cellH = Math.max(1, Math.floor(row.h / stack))
            cell.portletIds.forEach((pid, j) => {
              expected.set(pid, {
                x: x + cellW * i,
                y: y + cellH * j,
                w,
                h: j === stack - 1 ? row.h - cellH * (stack - 1) : cellH,
              })
            })
          })
        } else if (col.portletId) {
          expected.set(col.portletId, { x, y, w: col.w, h: row.h })
        }
        x += col.w
      }
      y += row.h
    }
    for (const p of portlets) {
      expect({ x: p.x, y: p.y, w: p.w, h: p.h }, `${id} portlet ${p.id} geometry`).toEqual(
        expected.get(p.id)
      )
    }
  })

  it('has unique portlet ids', () => {
    const ids = portlets.map(p => p.id)
    expect(new Set(ids).size, `${id} duplicate portlet id`).toBe(ids.length)
  })

  it('only maps dashboard filters the dashboard actually declares', () => {
    const declared = new Set((config.filters ?? []).map(f => f.id))
    for (const p of portlets) {
      for (const entry of p.dashboardFilterMapping ?? []) {
        const filterId = typeof entry === 'string' ? entry : entry.filterId
        expect(
          declared.has(filterId),
          `${id} portlet ${p.id} maps unknown filter ${filterId}`
        ).toBe(true)
      }
    }
  })

  it('every portlet query parses and references only members that exist in allCubes', () => {
    for (const p of portlets) {
      const query = JSON.parse(p.query ?? '{}') as Record<string, unknown>
      const members = membersOf(query)
      expect(members.length, `${id} portlet ${p.id} references no cube members`).toBeGreaterThan(0)
      for (const m of members) {
        expect(KNOWN_MEMBERS.has(m), `${id} portlet ${p.id} references unknown member ${m}`).toBe(
          true
        )
      }
      for (const axis of ['xAxis', 'yAxis', 'series', 'columns'] as const) {
        for (const m of p.chartConfig?.[axis] ?? []) {
          expect(KNOWN_MEMBERS.has(m), `${id} portlet ${p.id} chartConfig.${axis} ${m}`).toBe(true)
        }
      }
    }
    for (const f of config.filters ?? []) {
      const member = (f.filter as { member?: string }).member
      if (member && member !== UNIVERSAL) {
        expect(KNOWN_MEMBERS.has(member), `${id} filter ${f.id} member ${member}`).toBe(true)
      }
    }
  })

  it('requires an ungrouped query for every records table', () => {
    for (const p of portlets.filter(p => p.chartType === 'recordsTable')) {
      const query = JSON.parse(p.query ?? '{}')
      expect(query.ungrouped, `${id} recordsTable ${p.id} needs ungrouped: true`).toBe(true)
    }
  })

  it('keeps gauges out of rows too short to draw them', () => {
    const rowOf = new Map<string, number>()
    const groupById = new Map(groups.map(g => [g.id, g]))
    for (const row of rows) {
      for (const col of row.columns) {
        if (col.groupId) {
          for (const cell of groupById.get(col.groupId)?.cells ?? []) {
            for (const pid of cell.portletIds) rowOf.set(pid, row.h)
          }
        } else if (col.portletId) {
          rowOf.set(col.portletId, row.h)
        }
      }
    }
    for (const p of portlets.filter(p => p.chartType === 'gauge')) {
      expect(
        rowOf.get(p.id) ?? 0,
        `${id} gauge ${p.id} needs a row of h >= 3`
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('does not use the deprecated stacked flag', () => {
    for (const p of portlets) {
      expect(
        (p.displayConfig as Record<string, unknown> | undefined)?.stacked,
        `${id} portlet ${p.id} should use stackType, not stacked`
      ).toBeUndefined()
    }
  })

  it('pairs showSummary only with line and area charts', () => {
    for (const p of portlets) {
      if (p.displayConfig?.showSummary) {
        expect(['line', 'area'], `${id} portlet ${p.id} showSummary`).toContain(p.chartType)
      }
    }
  })

  it('pairs compact layout only with the KPI charts that own it', () => {
    for (const p of portlets) {
      if (p.displayConfig?.layout) {
        expect(['kpiNumber', 'kpiDelta'], `${id} portlet ${p.id} layout`).toContain(p.chartType)
      }
    }
  })
})

describe('template registry', () => {
  it('keys match, orders are unique, exactly one default, and lookups work', () => {
    for (const [key, t] of templates) expect(t.key, `${key} key`).toBe(key)
    const orders = templates.map(([, t]) => t.order)
    expect(new Set(orders).size, `duplicate order: ${orders.join(', ')}`).toBe(orders.length)
    expect(templates.filter(([, t]) => t.isDefault).map(([k]) => k)).toEqual(['tenant-overview'])
    expect(listTemplates().map(t => t.key)).toEqual(
      [...templates].sort((a, b) => a[1].order - b[1].order).map(([k]) => k)
    )
    expect(getTemplate('tenant-overview')?.name).toBe('Organisation Overview')
    expect(getTemplate('nope')).toBeNull()
  })

  it('tenant-overview exercises every ship-set cube', () => {
    const referenced = new Set(
      (getTemplate('tenant-overview')?.config.portlets ?? [])
        .flatMap(p => membersOf(JSON.parse(p.query ?? '{}')))
        .map(m => m.split('.')[0])
    )
    expect([...referenced].sort()).toEqual(['TenantActivityDaily', 'TenantUsers', 'Users'])
  })
})
