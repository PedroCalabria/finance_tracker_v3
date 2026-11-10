CREATE TABLE "debt_balance_anchors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"debt_id" uuid NOT NULL,
	"date" date NOT NULL,
	"balance_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debt_budgets" (
	"wallet_id" uuid NOT NULL,
	"from_month" char(7) NOT NULL,
	"amount_cents" integer NOT NULL,
	CONSTRAINT "debt_budgets_wallet_id_from_month_pk" PRIMARY KEY("wallet_id","from_month")
);
--> statement-breakpoint
CREATE TABLE "debt_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"debt_id" uuid NOT NULL,
	"date" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"kind" text NOT NULL,
	"extra_effect" text,
	"paid_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debt_settings" (
	"wallet_id" uuid PRIMARY KEY NOT NULL,
	"strategy" text DEFAULT 'avalanche' NOT NULL,
	"manual_order_set" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"creditor_name" text,
	"creditor_person_id" uuid,
	"structure" text NOT NULL,
	"monthly_rate_ppm" integer NOT NULL,
	"installment_cents" integer,
	"remaining_installments" smallint,
	"due_day" smallint,
	"min_payment_kind" text,
	"min_payment_value" integer,
	"contract_as_of" date NOT NULL,
	"accepts_extra" boolean NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"paid_off_on" date,
	"position" integer,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "debts_creditor_one" CHECK ("debts"."creditor_name" is null or "debts"."creditor_person_id" is null),
	CONSTRAINT "debts_interest_free_rate" CHECK ("debts"."structure" <> 'interest_free' or "debts"."monthly_rate_ppm" = 0),
	CONSTRAINT "debts_rate_range" CHECK ("debts"."monthly_rate_ppm" between 0 and 500000)
);
--> statement-breakpoint
ALTER TABLE "debt_balance_anchors" ADD CONSTRAINT "debt_balance_anchors_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_balance_anchors" ADD CONSTRAINT "debt_balance_anchors_debt_id_debts_id_fk" FOREIGN KEY ("debt_id") REFERENCES "public"."debts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_budgets" ADD CONSTRAINT "debt_budgets_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_debt_id_debts_id_fk" FOREIGN KEY ("debt_id") REFERENCES "public"."debts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_settings" ADD CONSTRAINT "debt_settings_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_creditor_person_id_people_id_fk" FOREIGN KEY ("creditor_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "debt_anchors_debt_date_uq" ON "debt_balance_anchors" USING btree ("debt_id","date");--> statement-breakpoint
CREATE INDEX "debt_payments_wallet_date_idx" ON "debt_payments" USING btree ("wallet_id","date");--> statement-breakpoint
CREATE INDEX "debt_payments_debt_idx" ON "debt_payments" USING btree ("debt_id");--> statement-breakpoint
CREATE INDEX "debts_wallet_idx" ON "debts" USING btree ("wallet_id") WHERE "debts"."deleted_at" is null;