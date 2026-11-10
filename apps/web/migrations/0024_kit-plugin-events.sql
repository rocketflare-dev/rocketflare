CREATE TABLE "plugin_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "trigger_event" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "trigger_event_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_events" ADD CONSTRAINT "plugin_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_events_tenant_created_idx" ON "plugin_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_events_tenant_name_key_idx" ON "plugin_events" USING btree ("tenant_id","name","idempotency_key") WHERE "plugin_events"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "plugin_events_tenant_isolation" ON "plugin_events" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);