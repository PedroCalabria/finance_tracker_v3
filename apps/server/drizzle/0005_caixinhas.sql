CREATE TABLE "investment_balance_anchors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"investment_id" uuid NOT NULL,
	"date" date NOT NULL,
	"balance_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_anchors_balance" CHECK ("investment_balance_anchors"."balance_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "investment_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"investment_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"tax_cents" integer,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_movements_amount" CHECK ("investment_movements"."amount_cents" > 0),
	CONSTRAINT "investment_movements_tax" CHECK (("investment_movements"."kind" = 'withdrawal' or "investment_movements"."tax_cents" is null) and coalesce("investment_movements"."tax_cents", 0) between 0 and "investment_movements"."amount_cents")
);
--> statement-breakpoint
CREATE TABLE "investment_settings" (
	"wallet_id" uuid PRIMARY KEY NOT NULL,
	"cdi_annual_ppm" integer,
	"cdi_updated_on" date
);
--> statement-breakpoint
CREATE TABLE "investments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text NOT NULL,
	"kind" text NOT NULL,
	"yield_kind" text NOT NULL,
	"fixed_rate_ppm" integer,
	"cdi_share_bp" integer,
	"redeemable_from" date,
	"tax_mode" text NOT NULL,
	"goal_cents" integer,
	"goal_month" char(7),
	"monthly_plan_cents" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"closed_on" date,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investments_fixed_rate" CHECK (("investments"."yield_kind" = 'fixed') = ("investments"."fixed_rate_ppm" is not null) and coalesce("investments"."fixed_rate_ppm", 0) between 0 and 100000),
	CONSTRAINT "investments_cdi_share" CHECK (("investments"."yield_kind" = 'cdi') = ("investments"."cdi_share_bp" is not null) and coalesce("investments"."cdi_share_bp", 1) between 1 and 30000),
	CONSTRAINT "investments_goal" CHECK ("investments"."goal_month" is null or "investments"."goal_cents" is not null),
	CONSTRAINT "investments_goal_positive" CHECK ("investments"."goal_cents" is null or "investments"."goal_cents" > 0),
	CONSTRAINT "investments_plan_positive" CHECK ("investments"."monthly_plan_cents" is null or "investments"."monthly_plan_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "investment_balance_anchors" ADD CONSTRAINT "investment_balance_anchors_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_balance_anchors" ADD CONSTRAINT "investment_balance_anchors_investment_id_investments_id_fk" FOREIGN KEY ("investment_id") REFERENCES "public"."investments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_movements" ADD CONSTRAINT "investment_movements_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_movements" ADD CONSTRAINT "investment_movements_investment_id_investments_id_fk" FOREIGN KEY ("investment_id") REFERENCES "public"."investments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_movements" ADD CONSTRAINT "investment_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_settings" ADD CONSTRAINT "investment_settings_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investments" ADD CONSTRAINT "investments_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investments" ADD CONSTRAINT "investments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "investment_anchors_date_uq" ON "investment_balance_anchors" USING btree ("investment_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_movements_initial_uq" ON "investment_movements" USING btree ("investment_id") WHERE "investment_movements"."kind" = 'initial';--> statement-breakpoint
CREATE INDEX "investment_movements_wallet_date_idx" ON "investment_movements" USING btree ("wallet_id","date");--> statement-breakpoint
CREATE INDEX "investment_movements_investment_idx" ON "investment_movements" USING btree ("investment_id");--> statement-breakpoint
CREATE INDEX "investments_wallet_idx" ON "investments" USING btree ("wallet_id") WHERE "investments"."deleted_at" is null;