CREATE TABLE "knowledge_value_judgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"key" text NOT NULL,
	"value_a" text NOT NULL,
	"value_b" text NOT NULL,
	"verdict" text NOT NULL,
	"confidence" real NOT NULL,
	"method" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_value_judgements_order" CHECK ("knowledge_value_judgements"."value_a" < "knowledge_value_judgements"."value_b"),
	CONSTRAINT "knowledge_value_judgements_confidence_range" CHECK ("knowledge_value_judgements"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "knowledge_value_judgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD COLUMN "value_ref" text;--> statement-breakpoint
ALTER TABLE "knowledge_value_judgements" ADD CONSTRAINT "knowledge_value_judgements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_value_judgements_pair_idx" ON "knowledge_value_judgements" USING btree ("tenant_id","entity_kind","entity_type","entity_id","key","value_a","value_b");--> statement-breakpoint
CREATE POLICY "knowledge_value_judgements_tenant_isolation" ON "knowledge_value_judgements" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);