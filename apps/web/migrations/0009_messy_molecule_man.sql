CREATE TABLE "analytics_page_groups" (
	"tenant_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "analytics_page_groups_page_id_group_id_pk" PRIMARY KEY("page_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "analytics_page_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_groups" (
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "document_groups_document_id_group_id_pk" PRIMARY KEY("document_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "document_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "group_members" (
	"tenant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "group_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "group_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_types_tenant_name_key" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "group_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_tenant_type_name_key" UNIQUE("tenant_id","group_type_id","name")
);
--> statement-breakpoint
ALTER TABLE "groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics_pages" ADD COLUMN "visibility" text DEFAULT 'tenant' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "visibility" text DEFAULT 'tenant' NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics_page_groups" ADD CONSTRAINT "analytics_page_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_page_groups" ADD CONSTRAINT "analytics_page_groups_page_id_analytics_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."analytics_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_page_groups" ADD CONSTRAINT "analytics_page_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_groups" ADD CONSTRAINT "document_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_groups" ADD CONSTRAINT "document_groups_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_groups" ADD CONSTRAINT "document_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_users"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_types" ADD CONSTRAINT "group_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_group_type_id_group_types_id_fk" FOREIGN KEY ("group_type_id") REFERENCES "public"."group_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_page_groups_tenant_group_idx" ON "analytics_page_groups" USING btree ("tenant_id","group_id");--> statement-breakpoint
CREATE INDEX "document_groups_tenant_group_idx" ON "document_groups" USING btree ("tenant_id","group_id");--> statement-breakpoint
CREATE INDEX "group_members_tenant_user_idx" ON "group_members" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "groups_tenant_type_idx" ON "groups" USING btree ("tenant_id","group_type_id");--> statement-breakpoint
CREATE POLICY "analytics_page_groups_tenant_isolation" ON "analytics_page_groups" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "document_groups_tenant_isolation" ON "document_groups" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "group_members_tenant_isolation" ON "group_members" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "group_types_tenant_isolation" ON "group_types" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "groups_tenant_isolation" ON "groups" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);