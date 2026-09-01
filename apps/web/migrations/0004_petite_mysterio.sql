CREATE TABLE "analytics_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"template_key" text,
	"config" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_activity_daily_facts" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"user_id" uuid,
	"event_count" integer NOT NULL,
	"distinct_event_types" integer NOT NULL,
	"first_event_at" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"fact_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_activity_daily_facts_grain" UNIQUE NULLS NOT DISTINCT("tenant_id","day","user_id")
);
--> statement-breakpoint
ALTER TABLE "tenant_activity_daily_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics_pages" ADD CONSTRAINT "analytics_pages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_pages" ADD CONSTRAINT "analytics_pages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_activity_daily_facts" ADD CONSTRAINT "tenant_activity_daily_facts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_pages_tenant_slug_idx" ON "analytics_pages" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "analytics_pages_tenant_order_idx" ON "analytics_pages" USING btree ("tenant_id","sort_order");--> statement-breakpoint
CREATE INDEX "tenant_activity_daily_facts_tenant_day_idx" ON "tenant_activity_daily_facts" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE POLICY "analytics_pages_tenant_isolation" ON "analytics_pages" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_activity_daily_facts_tenant_isolation" ON "tenant_activity_daily_facts" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);