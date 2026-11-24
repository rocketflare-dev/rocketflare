ALTER TABLE "chunks" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "context_model" text;--> statement-breakpoint
ALTER TABLE "chunks" drop column "search_vector";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(context, '') || ' ' || coalesce(heading_path, '') || ' ' || coalesce(table_header, '') || ' ' || text)) STORED;--> statement-breakpoint
CREATE INDEX "chunks_search_vector_idx" ON "chunks" USING gin ("search_vector");
