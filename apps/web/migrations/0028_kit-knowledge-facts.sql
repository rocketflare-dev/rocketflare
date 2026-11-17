-- Hand-added: the trigram index below needs pg_trgm (available on Neon and in the pgvector image;
-- scripts/migrate.ts also creates it before every run, as it does vector).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "knowledge_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"promoted_type" text,
	"promoted_id" text,
	"merged_into" uuid,
	"embedding" vector(1024),
	"embedding_model" text,
	"possible_matches" jsonb,
	"reviewer_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"value_text" text NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_id" uuid,
	"char_start" integer,
	"char_end" integer,
	"quote" text NOT NULL,
	"source_kind" text NOT NULL,
	"confidence" real NOT NULL,
	"state" text NOT NULL,
	"superseded_by_id" uuid,
	"conflicts_with" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"reviewer_user_id" uuid,
	"visibility" text DEFAULT 'tenant' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_facts_confidence_range" CHECK ("knowledge_facts"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "knowledge_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_entities" ADD CONSTRAINT "knowledge_entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entities" ADD CONSTRAINT "knowledge_entities_merged_into_knowledge_entities_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."knowledge_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entities" ADD CONSTRAINT "knowledge_entities_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_superseded_by_id_knowledge_facts_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."knowledge_facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_entities_tenant_type_name_idx" ON "knowledge_entities" USING btree ("tenant_id","type",lower("name"));--> statement-breakpoint
CREATE INDEX "knowledge_entities_name_trgm_idx" ON "knowledge_entities" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "knowledge_entities_embedding_idx" ON "knowledge_entities" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_entities_open_match_idx" ON "knowledge_entities" USING btree ("tenant_id","reviewer_user_id") WHERE "knowledge_entities"."possible_matches" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "knowledge_facts_tenant_entity_idx" ON "knowledge_facts" USING btree ("tenant_id","entity_kind","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "knowledge_facts_tenant_document_idx" ON "knowledge_facts" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "knowledge_facts_open_review_idx" ON "knowledge_facts" USING btree ("tenant_id","reviewer_user_id") WHERE "knowledge_facts"."state" IN ('unconfirmed', 'conflicting');--> statement-breakpoint
CREATE POLICY "knowledge_entities_tenant_isolation" ON "knowledge_entities" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "knowledge_facts_tenant_isolation" ON "knowledge_facts" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);