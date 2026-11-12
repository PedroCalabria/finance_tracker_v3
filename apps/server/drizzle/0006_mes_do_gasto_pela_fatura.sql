-- Mês do gasto pela fatura (ADR-0005): no crédito, todo item que não é de sistema conta no mês
-- em que cai a maior parte do período de compras da sua fatura (do fechamento da anterior até
-- a véspera do seu), o mesmo cálculo de `invoiceChargeMonth`. Antes era o mês da compra.
-- O fechamento da fatura anterior é o gravado ou, sem ela, o padrão do cartão (`defaultInvoiceDates`).
-- "Ajuste" e "Saldo restante" da fatura continuam no mês da fatura.
WITH f AS (
  SELECT o."id",
    inv."closing_date" AS closing,
    prev."closing_date" AS prev_closing,
    a."closing_day" AS cd,
    a."due_day" AS dd,
    (to_date(inv."reference_month" || '-01', 'YYYY-MM-DD') - interval '1 month')::date AS pm
  FROM "occurrences" o
  JOIN "items" i ON i."id" = o."item_id"
  JOIN "invoices" inv ON inv."id" = o."invoice_id"
  JOIN "accounts" a ON a."id" = inv."account_id"
  LEFT JOIN "invoices" prev ON prev."account_id" = inv."account_id"
    AND prev."reference_month" = to_char(to_date(inv."reference_month" || '-01', 'YYYY-MM-DD') - interval '1 month', 'YYYY-MM')
  WHERE i."method" = 'credit' AND i."system_kind" IS NULL
),
d AS (
  SELECT f.*,
    f.pm + (least(f.cd, extract(day from (f.pm + interval '1 month' - interval '1 day'))::int) - 1) AS def_closing,
    f.pm + (least(f.dd, extract(day from (f.pm + interval '1 month' - interval '1 day'))::int) - 1) AS def_due,
    (f.pm - interval '1 month')::date AS ppm
  FROM f
),
c AS (
  SELECT d."id", d.closing,
    coalesce(
      d.prev_closing,
      CASE WHEN d.def_closing < d.def_due THEN d.def_closing
        ELSE d.ppm + (least(d.cd, extract(day from (d.ppm + interval '1 month' - interval '1 day'))::int) - 1)
      END
    ) AS from_date
  FROM d
)
UPDATE "occurrences" o
SET "charge_month" = to_char(c.from_date + greatest(0, (c.closing - c.from_date - 1) / 2), 'YYYY-MM')
FROM c
WHERE c."id" = o."id" AND o."charge_month" IS DISTINCT FROM to_char(c.from_date + greatest(0, (c.closing - c.from_date - 1) / 2), 'YYYY-MM');
