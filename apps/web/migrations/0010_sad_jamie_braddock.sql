CREATE TYPE "public"."feature_flag_state" AS ENUM('off', 'on', 'rollout');--> statement-breakpoint
CREATE TYPE "public"."feature_rollout_unit" AS ENUM('tenant', 'user');--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"state" "feature_flag_state" DEFAULT 'off' NOT NULL,
	"rollout_percent" integer DEFAULT 0 NOT NULL,
	"rollout_unit" "feature_rollout_unit" DEFAULT 'tenant' NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_rollout_percent_range" CHECK ("feature_flags"."rollout_percent" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "tenant_feature_overrides" (
	"tenant_id" uuid NOT NULL,
	"flag_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"set_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_feature_overrides_tenant_id_flag_key_pk" PRIMARY KEY("tenant_id","flag_key")
);
--> statement-breakpoint
ALTER TABLE "tenant_feature_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_feature_overrides" ADD CONSTRAINT "tenant_feature_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_feature_overrides" ADD CONSTRAINT "tenant_feature_overrides_flag_key_feature_flags_key_fk" FOREIGN KEY ("flag_key") REFERENCES "public"."feature_flags"("key") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tenant_feature_overrides" ADD CONSTRAINT "tenant_feature_overrides_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_feature_overrides_flag_idx" ON "tenant_feature_overrides" USING btree ("flag_key");--> statement-breakpoint
CREATE POLICY "tenant_feature_overrides_tenant_isolation" ON "tenant_feature_overrides" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);