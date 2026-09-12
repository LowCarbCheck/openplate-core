CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"time_zone" text NOT NULL,
	"locale" text NOT NULL,
	"catch_up_minute" integer,
	"fast_target_enabled" boolean DEFAULT false NOT NULL,
	"last_catch_up_day" date,
	"last_seen_day" date NOT NULL,
	"wake_at" timestamp with time zone,
	"sends_today_day" date,
	"sends_today" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_catch_up_minute_range" CHECK ("push_subscriptions"."catch_up_minute" IS NULL OR ("push_subscriptions"."catch_up_minute" >= 0 AND "push_subscriptions"."catch_up_minute" <= 1439))
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_account_idx" ON "push_subscriptions" USING btree ("account_id");