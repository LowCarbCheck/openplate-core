CREATE TABLE "pulse_day_contributors" (
	"day" date NOT NULL,
	"account_id" integer NOT NULL,
	CONSTRAINT "pulse_day_contributors_day_account_id_pk" PRIMARY KEY("day","account_id")
);
--> statement-breakpoint
CREATE TABLE "pulse_days" (
	"day" date PRIMARY KEY NOT NULL,
	"meals" integer DEFAULT 0 NOT NULL,
	"photos" integer DEFAULT 0 NOT NULL,
	"kcal" integer DEFAULT 0 NOT NULL,
	"protein" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pulse_idempotency" (
	"key" text PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pulse_presence" (
	"account_id" integer PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pulse_day_contributors" ADD CONSTRAINT "pulse_day_contributors_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pulse_idempotency" ADD CONSTRAINT "pulse_idempotency_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pulse_presence" ADD CONSTRAINT "pulse_presence_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;