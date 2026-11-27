ALTER TABLE "pending_uploads" DROP CONSTRAINT "pending_uploads_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "pending_uploads" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_uploads" ADD CONSTRAINT "pending_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;