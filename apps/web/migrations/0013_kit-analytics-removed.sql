-- Analytics left the kit for `rocketflare-plugin-analytics` (D31, Phase C, kit 0.6.0).
--
-- Edited after `pnpm db:generate`, which is allowed for a migration that has not been applied:
-- `IF EXISTS` on each table, and the three `DROP POLICY` statements removed because dropping a
-- table drops its policies anyway and `DROP POLICY IF EXISTS` still errors when the table is gone.
-- A copy that already removed them by hand, or that never reached 0.6.0's predecessors, then
-- applies this cleanly instead of failing on the first statement.
--
-- Nothing here is lost that mattered: `analytics_tenant_activity_daily_facts` is derived data the
-- plugin's `:15` cron rebuilds, and an app that wants the FEATURE back installs the plugin, whose
-- own `pnpm db:generate` recreates `analytics_pages` and `analytics_page_groups`. An app that
-- wants its dashboard ROWS back must install the plugin BEFORE running `db:generate` — those two
-- table names are unchanged, so with the plugin present nothing drops them at all.
DROP TABLE IF EXISTS "analytics_page_groups" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "analytics_pages" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "tenant_activity_daily_facts" CASCADE;
