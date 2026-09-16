CREATE TABLE "agent_run_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_run_interrupts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"message" text,
	"tool_call_id" text,
	"response_schema" jsonb,
	"spec" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"expires_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_interrupts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX "agent_runs_active_exclusive_idx";--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_run_artifacts" ADD CONSTRAINT "agent_run_artifacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_artifacts" ADD CONSTRAINT "agent_run_artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_interrupts" ADD CONSTRAINT "agent_run_interrupts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_interrupts" ADD CONSTRAINT "agent_run_interrupts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_interrupts" ADD CONSTRAINT "agent_run_interrupts_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_artifacts_run_key_idx" ON "agent_run_artifacts" USING btree ("run_id","key");--> statement-breakpoint
CREATE INDEX "agent_run_artifacts_tenant_created_idx" ON "agent_run_artifacts" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_run_artifacts_tenant_kind_idx" ON "agent_run_artifacts" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_interrupts_run_key_idx" ON "agent_run_interrupts" USING btree ("run_id","key");--> statement-breakpoint
CREATE INDEX "agent_run_interrupts_tenant_status_idx" ON "agent_run_interrupts" USING btree ("tenant_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_run_interrupts_tenant_run_idx" ON "agent_run_interrupts" USING btree ("tenant_id","run_id");--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_active_exclusive_idx" ON "agent_runs" USING btree ("tenant_id","agent_key") WHERE "agent_runs"."status" IN ('queued', 'running', 'awaiting_input');--> statement-breakpoint
CREATE POLICY "agent_run_artifacts_tenant_isolation" ON "agent_run_artifacts" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_run_interrupts_tenant_isolation" ON "agent_run_interrupts" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);