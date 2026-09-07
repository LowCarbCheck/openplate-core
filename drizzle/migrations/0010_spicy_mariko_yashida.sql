CREATE TABLE "feedback_images" (
	"report_id" integer PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"measurements" jsonb NOT NULL,
	"has_image" boolean NOT NULL,
	"consent_agreed_at" timestamp NOT NULL,
	"consent_wording_version" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_reports_key_present" CHECK (length("feedback_reports"."idempotency_key") > 0),
	CONSTRAINT "feedback_reports_consent_version_present" CHECK (length("feedback_reports"."consent_wording_version") > 0)
);
--> statement-breakpoint
ALTER TABLE "feedback_images" ADD CONSTRAINT "feedback_images_report_id_feedback_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."feedback_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_reports_account_key_idx" ON "feedback_reports" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "feedback_reports_account_created_idx" ON "feedback_reports" USING btree ("account_id","created_at");