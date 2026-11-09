-- Mês do gasto (ADR-0004, ADR-0005): no crédito, o mês da compra ou da cobrança;
-- fora dele, igual ao mês da ocorrência. Backfill dos lançamentos existentes.
ALTER TABLE "occurrences" ADD COLUMN "charge_month" char(7);--> statement-breakpoint
UPDATE "occurrences" SET "charge_month" = "competence_month";--> statement-breakpoint
-- Crédito, compra única: o mês da compra. Fora do intervalo possível (mais de 2 meses antes da
-- fatura ou depois dela: última parcela "PARC n/n" importada da fatura, gravada como única com a
-- data da compra original, ou compra movida), o mês anterior ao da fatura.
WITH c AS (
  SELECT o."id",
    date_trunc('month', i."entry_date")::date AS m,
    to_date(o."competence_month" || '-01', 'YYYY-MM-DD') AS comp
  FROM "occurrences" o JOIN "items" i ON i."id" = o."item_id"
  WHERE i."method" = 'credit' AND i."system_kind" IS NULL AND i."form" = 'single'
)
UPDATE "occurrences" o SET "charge_month" = CASE
    WHEN c.m > c.comp OR c.m < c.comp - interval '2 months' THEN to_char(c.comp - interval '1 month', 'YYYY-MM')
    ELSE to_char(c.m, 'YYYY-MM')
  END
FROM c WHERE c."id" = o."id";--> statement-breakpoint
-- Crédito, parcela k: mês da compra + (k - 1). Fora do intervalo possível (mais de 2 meses
-- antes da fatura ou depois dela: parcela antiga importada da fatura ou movida), o mês anterior ao da fatura.
WITH c AS (
  SELECT o."id",
    (date_trunc('month', i."entry_date") + make_interval(months => coalesce(o."installment_number", 1) - 1))::date AS m,
    to_date(o."competence_month" || '-01', 'YYYY-MM-DD') AS comp
  FROM "occurrences" o JOIN "items" i ON i."id" = o."item_id"
  WHERE i."method" = 'credit' AND i."system_kind" IS NULL AND i."form" = 'installment'
)
UPDATE "occurrences" o SET "charge_month" = CASE
    WHEN c.m > c.comp OR c.m < c.comp - interval '2 months' THEN to_char(c.comp - interval '1 month', 'YYYY-MM')
    ELSE to_char(c.m, 'YYYY-MM')
  END
FROM c WHERE c."id" = o."id";--> statement-breakpoint
-- Crédito, recorrente: pelo fechamento da fatura. Se o dia da cobrança (limitado ao último dia)
-- cai antes do fechamento, no mês do fechamento, é esse mês; senão, o anterior. Sem fatura, o mês anterior ao dela.
WITH c AS (
  SELECT o."id",
    to_date(o."competence_month" || '-01', 'YYYY-MM-DD') AS comp,
    inv."closing_date" AS closing,
    date_trunc('month', inv."closing_date")::date AS cm,
    extract(day from i."entry_date")::int AS d
  FROM "occurrences" o
  JOIN "items" i ON i."id" = o."item_id"
  LEFT JOIN "invoices" inv ON inv."id" = o."invoice_id"
  WHERE i."method" = 'credit' AND i."system_kind" IS NULL AND i."form" = 'recurring'
)
UPDATE "occurrences" o SET "charge_month" = CASE
    WHEN c.closing IS NULL THEN to_char(c.comp - interval '1 month', 'YYYY-MM')
    WHEN c.cm + (least(c.d, extract(day from (c.cm + interval '1 month' - interval '1 day'))::int) - 1) < c.closing THEN to_char(c.cm, 'YYYY-MM')
    ELSE to_char(c.cm - interval '1 month', 'YYYY-MM')
  END
FROM c WHERE c."id" = o."id";--> statement-breakpoint
ALTER TABLE "occurrences" ALTER COLUMN "charge_month" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "occurrences_wallet_charge_idx" ON "occurrences" USING btree ("wallet_id","charge_month");
