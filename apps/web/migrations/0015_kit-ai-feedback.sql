CREATE TABLE "ai_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target" text NOT NULL,
	"target_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text,
	"user_id" uuid,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_feedback_tenant_target_user_idx" ON "ai_feedback" USING btree ("tenant_id","target","target_id","user_id");--> statement-breakpoint
CREATE INDEX "ai_feedback_tenant_created_idx" ON "ai_feedback" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "ai_feedback_tenant_isolation" ON "ai_feedback" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);