CREATE TABLE "invitation_send_counters" (
	"scope" text NOT NULL,
	"day" date DEFAULT (now() at time zone 'utc')::date NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "invitation_send_counters_scope_day_pk" PRIMARY KEY("scope","day")
);
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "last_sent_at" timestamp with time zone DEFAULT now() NOT NULL;