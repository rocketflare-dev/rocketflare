ALTER TABLE "chunks" ADD COLUMN "embedding_model" text;--> statement-breakpoint
-- Backfill: the dense leg now filters on chunks.embedding_model, so every existing chunk takes its
-- document's model, or no tenant's dense search would find anything after the upgrade.
UPDATE "chunks" SET "embedding_model" = "documents"."embedding_model" FROM "documents" WHERE "documents"."id" = "chunks"."document_id" AND "chunks"."embedding_model" IS NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "heading_path" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "table_header" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "page" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "char_start" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "char_end" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading_path, '') || ' ' || coalesce(table_header, '') || ' ' || text)) STORED;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "content_hash" text;--> statement-breakpoint
CREATE INDEX "chunks_search_vector_idx" ON "chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "documents_tenant_source_hash_idx" ON "documents" USING btree ("tenant_id","source","content_hash");