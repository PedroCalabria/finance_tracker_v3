CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "reimburses_item_id" uuid;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "people_name_uq" ON "people" USING btree ("wallet_id",lower("name")) WHERE "people"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "people_wallet_idx" ON "people" USING btree ("wallet_id");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_reimburses_item_id_items_id_fk" FOREIGN KEY ("reimburses_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_reimburses_idx" ON "items" USING btree ("reimburses_item_id");