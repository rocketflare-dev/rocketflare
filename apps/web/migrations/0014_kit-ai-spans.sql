CREATE TABLE "ai_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"status_message" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"run_id" uuid,
	"conversation_id" uuid,
	"user_id" uuid,
	"model" text,
	"provider" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"tool_name" text,
	"attributes" jsonb NOT NULL,
	"content" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_spans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "ai_spans" ADD CONSTRAINT "ai_spans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_spans_tenant_trace_span_idx" ON "ai_spans" USING btree ("tenant_id","trace_id","span_id");--> statement-breakpoint
CREATE INDEX "ai_spans_tenant_started_idx" ON "ai_spans" USING btree ("tenant_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_spans_tenant_run_idx" ON "ai_spans" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "ai_spans_tenant_conversation_idx" ON "ai_spans" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE POLICY "ai_spans_tenant_isolation" ON "ai_spans" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);