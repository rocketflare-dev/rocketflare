CREATE TABLE "agent_run_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"result" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_effects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "agent_run_effects" ADD CONSTRAINT "agent_run_effects_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_effects" ADD CONSTRAINT "agent_run_effects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_effects_run_key_idx" ON "agent_run_effects" USING btree ("run_id","key");--> statement-breakpoint
CREATE INDEX "agent_run_effects_tenant_run_idx" ON "agent_run_effects" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE POLICY "agent_run_effects_tenant_isolation" ON "agent_run_effects" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);