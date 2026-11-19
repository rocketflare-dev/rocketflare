ALTER TABLE "agent_run_interrupts" ADD COLUMN "assignee_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_interrupts" ADD COLUMN "assignee_group_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_interrupts" ADD COLUMN "remind_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_run_interrupts" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "agent_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "worker_version_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "budget" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_parent_run_id_agent_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_interrupts_remind_idx" ON "agent_run_interrupts" USING btree ("remind_at") WHERE "agent_run_interrupts"."status" = 'pending' AND "agent_run_interrupts"."reminded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_runs_tenant_parent_idx" ON "agent_runs" USING btree ("tenant_id","parent_run_id") WHERE "agent_runs"."parent_run_id" IS NOT NULL;