CREATE TABLE "legal_declarations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"contract_reference" text,
	"termination_type" text,
	"reason" text,
	"requested_date" date,
	"timing" text,
	"language" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" integer,
	"forwarded_at" timestamp with time zone,
	"forward_error" text
);
--> statement-breakpoint
ALTER TABLE "legal_declarations" ADD CONSTRAINT "legal_declarations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;