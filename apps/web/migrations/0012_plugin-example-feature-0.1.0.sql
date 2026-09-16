CREATE TABLE "example_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "example_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "example_notes" ADD CONSTRAINT "example_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "example_notes" ADD CONSTRAINT "example_notes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "example_notes_tenant_created_idx" ON "example_notes" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "example_notes_tenant_owner_idx" ON "example_notes" USING btree ("tenant_id","owner_user_id");--> statement-breakpoint
CREATE POLICY "example_notes_tenant_isolation" ON "example_notes" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);