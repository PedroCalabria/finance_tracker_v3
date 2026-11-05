CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"reader_id" text NOT NULL,
	"kind" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"invoice_id" uuid,
	"counts" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"fingerprint" char(64) NOT NULL,
	"line_date" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"direction" text NOT NULL,
	"description" text NOT NULL,
	"document" text,
	"action" text NOT NULL,
	"occurrence_id" uuid,
	"payment_id" uuid,
	"invoice_id" uuid,
	"invoice_payment_id" uuid,
	"item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "import_key" text;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_lines" ADD CONSTRAINT "import_lines_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_lines" ADD CONSTRAINT "import_lines_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_lines" ADD CONSTRAINT "import_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_lines" ADD CONSTRAINT "import_lines_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_lines" ADD CONSTRAINT "import_lines_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_lines" ADD CONSTRAINT "import_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_lines" ADD CONSTRAINT "import_lines_invoice_payment_id_invoice_payments_id_fk" FOREIGN KEY ("invoice_payment_id") REFERENCES "public"."invoice_payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_lines" ADD CONSTRAINT "import_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batches_wallet_idx" ON "import_batches" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_lines_fingerprint_uq" ON "import_lines" USING btree ("wallet_id","account_id","fingerprint");--> statement-breakpoint
CREATE INDEX "import_lines_payment_idx" ON "import_lines" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "import_lines_occurrence_idx" ON "import_lines" USING btree ("occurrence_id");