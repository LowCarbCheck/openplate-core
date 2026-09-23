CREATE TABLE "ai_trial_intakes" (
	"account_id" integer NOT NULL,
	"intake_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"delivered" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ai_trial_intakes_account_id_intake_id_pk" PRIMARY KEY("account_id","intake_id")
);
--> statement-breakpoint
CREATE TABLE "trial_address_hashes" (
	"hash" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "trial_scans" integer;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "trial_scans_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_instance_days" ADD COLUMN "trial_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "signup_invites" ADD COLUMN "trial_scans" integer;--> statement-breakpoint
ALTER TABLE "ai_trial_intakes" ADD CONSTRAINT "ai_trial_intakes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_trial_intakes_created_idx" ON "ai_trial_intakes" USING btree ("created_at");