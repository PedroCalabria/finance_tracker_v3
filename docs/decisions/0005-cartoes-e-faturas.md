# 0005 — Cartões e faturas

**Status:** aceita · 03/11/2026 · código: `packages/shared/src/invoices.ts`, `apps/server/src/domain/invoice*.ts`

## Decisão
- **Fatura = cartão × mês de vencimento** (`reference_month`). Índice único `(account_id, reference_month)`; criada sob demanda (`ensureInvoice`, idempotente).
- **Datas padrão:** vencimento = dia de vencimento do cartão naquele mês; fechamento = o último "dia de fechamento" **antes** do vencimento (mesmo mês se o dia de fechamento é menor que o de vencimento; senão, mês anterior). Ex.: fecha 25/vence 1 → fatura de nov fecha 25/10.
- **Em qual fatura cai a compra:** compra **antes** do fechamento entra na fatura que fecha; **no dia do fechamento ou depois**, vai para a seguinte. Considera datas ajustadas manualmente nas faturas já criadas.
- **Datas que mudam:** a pessoa ajusta fechamento/vencimento **só daquele mês** na própria fatura ("ajustar"); os itens acompanham o vencimento. Mudar os dias padrão do cartão vale só para faturas ainda não criadas.
- **Parcelas no crédito:** parcela k na fatura (primeira + k − 1).
- **Recorrente no crédito:** cobrada todo mês no dia da data do cadastro; a fatura é calculada por mês; meses futuros entram projetados no total da fatura.
- **Itens no crédito não têm "Marcar como pago":** o status vem da fatura (`Fatura em aberto · nov`, `Fatura atrasada`, `Fatura paga`, `Fatura parcialmente paga`).
- **Pagar fatura:** a pessoa informa o **valor real** (do banco), o **valor pago** e a data.
  - Real ≠ soma dos itens → item de sistema **"Ajuste da fatura"** com a diferença (pode ser negativo). Um por fatura, recalculado.
  - Pago < real → **parcialmente paga**: o restante vira automaticamente o item **"Saldo restante da fatura <mês> · <cartão>"** na fatura seguinte e esta fica `carried` (encerrada), deixando de contar como atraso — o valor nunca conta duas vezes. Juros aparecem pelo ajuste da fatura seguinte.
  - Fatura paga ou encerrada não aceita outro pagamento (`invoice_closed`).
- **Desfazer pagamento:** remove o pagamento e o saldo transferido e reabre a fatura; bloqueado se a fatura seguinte (que contém o saldo) já foi paga.
- **Mover item de fatura:** só entre faturas abertas do mesmo cartão (anterior/seguinte na interface).
- **Bloco "Faturas do mês"** acima da tabela de despesas: uma linha por cartão com itens no mês, mais faturas **atrasadas** de meses anteriores quando o mês é o atual.

## Consequências
- Faturas vazias são criadas ao abrir o mês (uma por cartão ativo), mas só aparecem com itens ou pagamentos.
- A importação de extrato (fase 2) deve conciliar o pagamento da fatura com a fatura, não lançá-lo como despesa.
