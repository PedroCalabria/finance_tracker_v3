# 0005 — Cartões e faturas

**Status:** aceita · 03/11/2026 · revisada em 08/11/2026 · código: `packages/shared/src/invoices.ts`, `apps/server/src/domain/invoice*.ts`

## Decisão
- **Fatura = cartão × mês de vencimento** (`reference_month`). Índice único `(account_id, reference_month)`; criada sob demanda (`ensureInvoice`, idempotente).
- **Datas padrão:** vencimento = dia de vencimento do cartão naquele mês; fechamento = o último "dia de fechamento" **antes** do vencimento (mesmo mês se o dia de fechamento é menor que o de vencimento; senão, mês anterior). Ex.: fecha 25/vence 1 → fatura de nov fecha 25/10.
- **Em qual fatura cai a compra:** compra **antes** do fechamento entra na fatura que fecha; **no dia do fechamento ou depois**, vai para a seguinte. Considera datas ajustadas manualmente nas faturas já criadas.
- **Datas que mudam:** a pessoa ajusta fechamento/vencimento **só daquele mês** na própria fatura ("ajustar"); os itens acompanham o vencimento. Mudar os dias padrão do cartão vale só para faturas ainda não criadas.
- **Parcelas no crédito:** parcela k na fatura (primeira + k − 1).
- **Recorrente no crédito:** cobrada todo mês no dia da data do cadastro; a fatura é calculada por mês; a cobrança é gravada quando chega (mesmo com fatura futura) e as cobranças futuras entram projetadas no total da fatura.
- **Dois meses no crédito (ADR-0004):** a ocorrência fica na fatura pelo mês de vencimento (`competence_month`) e na tabela e nos cards pelo **mês do gasto** (`charge_month`, o mês da compra). Assim a compra de 10/11 num cartão que vence dia 1 conta como gasto de novembro e é paga na fatura de dezembro. O pagamento da fatura é caixa, não gasto: não entra no consumo do mês (só em "Na conta até agora"). O "Saldo restante da fatura" fica fora do consumo; o "Ajuste da fatura" conta no mês da fatura.
- **Itens no crédito não têm "Marcar como pago":** o status vem da fatura (`Fatura em aberto · nov`, `Fatura atrasada`, `Fatura paga`, `Fatura parcialmente paga`).
- **Pagar fatura:** a pessoa informa o **valor real** (do banco), o **valor pago** e a data.
  - Real ≠ soma dos itens → item de sistema **"Ajuste da fatura"** com a diferença (pode ser negativo). Um por fatura, recalculado.
  - Pago < real → **parcialmente paga**: o restante vira automaticamente o item **"Saldo restante da fatura <mês> · <cartão>"** na fatura seguinte e esta fica `carried` (encerrada), deixando de contar como atraso — o valor nunca conta duas vezes. Juros aparecem pelo ajuste da fatura seguinte.
  - Fatura paga ou encerrada não aceita outro pagamento (`invoice_closed`).
- **Desfazer pagamento:** remove o pagamento e o saldo transferido e reabre a fatura; bloqueado se a fatura seguinte (que contém o saldo) já foi paga.
- **Mover item de fatura:** só entre faturas abertas do mesmo cartão (anterior/seguinte na interface).
- **Bloco "Faturas do mês"** acima da tabela de despesas: uma linha por cartão com itens no mês, mais faturas **atrasadas** de meses anteriores quando o mês é o atual. Continua pelo vencimento e mostra o **período das compras** de cada fatura (`purchasesFrom` = fechamento da anterior, `purchasesTo` = véspera do fechamento), porque as compras dela aparecem na tabela nos meses em que foram feitas.

## Consequências
- Faturas vazias são criadas ao abrir o mês (uma por cartão ativo), mas só aparecem com itens ou pagamentos.
- A importação (ADR-0010) concilia o pagamento da fatura com a fatura (`payInvoice`), nunca como despesa.
- **Valor real antes do pagamento:** importar a fatura do banco grava o total em `real_amount_cents` da fatura aberta, sem pagá-la. O pagamento vem com esse valor preenchido ("Valor da fatura importada"), e o "Ajuste da fatura" continua nascendo no pagamento.
- **Datas do banco:** a importação pode ajustar fechamento e vencimento daquele mês, como o "ajustar" manual.
- **Compra parcelada antiga (`pastInstallmentsPaid`, ADR-0004):** no cadastro, cada fatura de mês anterior ao atual que recebeu uma parcela é paga (valor real = pago = total, na data do vencimento) **se estiver aberta, sem pagamentos e sem itens de outros lançamentos**. O critério não é "criada agora" porque abrir o mês já cria faturas vazias. Faturas passadas com outros itens continuam como estão, para não quitar em silêncio o que a pessoa ainda acompanha.
