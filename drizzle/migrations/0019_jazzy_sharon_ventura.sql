ALTER TABLE "signup_invites" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "signup_invites" ADD COLUMN "trial_key" text;--> statement-breakpoint
CREATE INDEX "signup_invites_trial_key_idx" ON "signup_invites" USING btree ("trial_key");