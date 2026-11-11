CREATE TABLE "tenant_creation_counters" (
	"user_id" uuid NOT NULL,
	"day" date DEFAULT (now() at time zone 'utc')::date NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_creation_counters_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "tenant_creation_counters" ADD CONSTRAINT "tenant_creation_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;