/**
 * The SELECT that builds `tenant_activity_daily_facts` for ONE tenant (D19): `activity_events`
 * grouped by UTC day and actor. Column ORDER must match the fact table's declaration order —
 * `refresh.ts` names the INSERT's target columns from `getTableColumns`, so a drift fails loudly
 * ("INSERT has more target columns than expressions") instead of shifting values silently.
 * Parameterised (`${tenantId}` is a bound value), never string-interpolated.
 */
import { type SQL, sql } from 'drizzle-orm'
import { activityEvents } from '../../../../db/schema'

export function tenantActivityDailySelect(tenantId: string): SQL {
  const e = activityEvents
  return sql`
    select
      ${e.tenantId}                                  as tenant_id,
      (${e.createdAt} at time zone 'UTC')::date      as day,
      ${e.userId}                                    as user_id,
      count(*)::int                                  as event_count,
      count(distinct ${e.type})::int                 as distinct_event_types,
      min(${e.createdAt})                            as first_event_at,
      max(${e.createdAt})                            as last_event_at,
      now()                                          as fact_refreshed_at
    from ${e}
    where ${e.tenantId} = ${tenantId}
    group by ${e.tenantId}, (${e.createdAt} at time zone 'UTC')::date, ${e.userId}`
}
