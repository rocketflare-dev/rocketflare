CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"visibility" text DEFAULT 'private' NOT NULL,
	"kind" text DEFAULT 'fact' NOT NULL,
	"text" text NOT NULL,
	"occurred_start" timestamp with time zone,
	"occurred_end" timestamp with time zone,
	"mentioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedding_model" text,
	"text_signals" text DEFAULT '' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("memories"."text", '') || ' ' || coalesce("memories"."text_signals", ''))) STORED,
	"source_conversation_id" uuid,
	"source_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"invalidated_at" timestamp with time zone,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"name" text NOT NULL,
	"normalised_name" text NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entities_partition_name_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","owner_user_id","normalised_name")
);
--> statement-breakpoint
ALTER TABLE "memory_entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_entity_links" (
	"tenant_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	CONSTRAINT "memory_entity_links_memory_id_entity_id_pk" PRIMARY KEY("memory_id","entity_id")
);
--> statement-breakpoint
ALTER TABLE "memory_entity_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_groups" (
	"tenant_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "memory_groups_memory_id_group_id_pk" PRIMARY KEY("memory_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "memory_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "memory_retained_through_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entity_links" ADD CONSTRAINT "memory_entity_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entity_links" ADD CONSTRAINT "memory_entity_links_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entity_links" ADD CONSTRAINT "memory_entity_links_entity_id_memory_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."memory_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_groups" ADD CONSTRAINT "memory_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_groups" ADD CONSTRAINT "memory_groups_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_groups" ADD CONSTRAINT "memory_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_tenant_owner_mentioned_idx" ON "memories" USING btree ("tenant_id","owner_user_id","mentioned_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memories_tenant_owner_occurred_idx" ON "memories" USING btree ("tenant_id","owner_user_id","occurred_start");--> statement-breakpoint
CREATE INDEX "memories_tenant_conversation_idx" ON "memories" USING btree ("tenant_id","source_conversation_id");--> statement-breakpoint
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memories_search_idx" ON "memories" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "memory_entity_links_tenant_entity_idx" ON "memory_entity_links" USING btree ("tenant_id","entity_id");--> statement-breakpoint
CREATE INDEX "memory_groups_tenant_group_idx" ON "memory_groups" USING btree ("tenant_id","group_id");--> statement-breakpoint
CREATE POLICY "memories_tenant_isolation" ON "memories" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "memory_entities_tenant_isolation" ON "memory_entities" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "memory_entity_links_tenant_isolation" ON "memory_entity_links" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "memory_groups_tenant_isolation" ON "memory_groups" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);