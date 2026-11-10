ALTER TABLE "chunks" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_platform_source_external_uq" ON "documents" USING btree ("source","external_id") WHERE "documents"."tenant_id" is null;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_platform_needs_source" CHECK ("documents"."tenant_id" is not null or ("documents"."source" is not null and "documents"."external_id" is not null));--> statement-breakpoint
CREATE POLICY "chunks_platform_read" ON "chunks" AS PERMISSIVE FOR SELECT TO "rocketflare_app" USING (tenant_id is null);--> statement-breakpoint
CREATE POLICY "documents_platform_read" ON "documents" AS PERMISSIVE FOR SELECT TO "rocketflare_app" USING (tenant_id is null);