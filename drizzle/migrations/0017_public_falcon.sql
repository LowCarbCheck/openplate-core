CREATE TABLE "instance_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"nutrient_reference_basis" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "instance_settings_single_row" CHECK ("instance_settings"."id" = 1),
	CONSTRAINT "instance_settings_nutrient_reference_basis" CHECK ("instance_settings"."nutrient_reference_basis" in ('dge', 'efsa', 'us'))
);
