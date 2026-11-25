CREATE TYPE "public"."agent_run_turn_role" AS ENUM('model', 'tool');--> statement-breakpoint
CREATE TYPE "public"."agent_run_turn_status" AS ENUM('started', 'settled');--> statement-breakpoint
CREATE TABLE "agent_run_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"loop_key" text NOT NULL,
	"turn" integer NOT NULL,
	"role" "agent_run_turn_role" NOT NULL,
	"tool_call_id" text,
	"tool_name" text,
	"status" "agent_run_turn_status" DEFAULT 'settled' NOT NULL,
	"content" jsonb,
	"request_hash" text,
	"system_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_run_turns" ADD CONSTRAINT "agent_run_turns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_turns" ADD CONSTRAINT "agent_run_turns_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_turns_model_idx" ON "agent_run_turns" USING btree ("run_id","loop_key","turn") WHERE role = 'model';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_turns_tool_idx" ON "agent_run_turns" USING btree ("run_id","loop_key","tool_call_id") WHERE role = 'tool';--> statement-breakpoint
CREATE INDEX "agent_run_turns_tenant_run_idx" ON "agent_run_turns" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "agent_run_turns_tenant_updated_idx" ON "agent_run_turns" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE POLICY "agent_run_turns_tenant_isolation" ON "agent_run_turns" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);