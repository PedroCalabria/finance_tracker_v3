# 0005 — Cartões e faturas

**Status:** aceita · 03/11/2026 · revisada em 08/11/2026 e 12/11/2026 · código: `packages/shared/src/invoices.ts`, `apps/server/src/domain/invoice*.ts`

## Decisão
- **Fatura = cartão × mês de vencimento** (`reference_month`). Índice único `(account_id, reference_month)`; criada sob demanda (`ensureInvoice`, idempotente).
- **Datas padrão:** vencimento = dia de vencimento do cartão naquele mês; fechamento = o último "dia de fechamento" **antes** do vencimento (mesmo mês se o dia de fechamento é menor que o de vencimento; senão, mês anterior). Ex.: fecha 25/vence 1 → fatura de nov fecha 25/10.
- **Em qual fatura cai a compra:** compra **antes** do fechamento entra na fatura que fecha; **no dia do fechamento ou depois**, vai para a seguinte. Considera datas ajustadas manualmente nas faturas já criadas.
- **Datas que mudam:** a pessoa ajusta fechamento/vencimento **só daquele mês** na própria fatura ("ajustar"); os itens acompanham o vencimento. Mudar os dias padrão do cartão vale só para faturas ainda não criadas.
- **Parcelas no crédito:** parcela k na fatura (primeira + k − 1).
- **Recorrente no crédito:** cobrada todo mês no dia da data do cadastro; a fatura é calculada por mês; a cobrança é gravada quando chega (mesmo com fatura futura) e as cobranças futuras entram projetadas no total da fatura.
- **Dois meses no crédito (ADR-0004):** a ocorrência fica na fatura pelo mês de vencimento (`competence_month`) e na tabela e nos cards pelo **mês do gasto** (`charge_month`).
- **Mês do gasto no crédito = o do período de compras da fatura** (`invoiceChargeMonth`, `packages/shared/src/invoices.ts`): o mês em que cai a **maior parte** do período (do fechamento da anterior até a véspera do seu; empate, o primeiro). Todas as compras de uma fatura contam no mesmo mês, e faturas seguidas em meses seguidos. Ex.: fecha 28/vence 5 → a fatura de dez tem as compras de 28/10 a 27/11 e elas contam como **novembro** (a compra de 30/10, depois do fechamento, já é de novembro). Fecha 25/vence 1 → compras de 25/10 a 24/11 na fatura de dez, novembro. Fecha 3/vence 10 → compras de 03/10 a 02/11 na fatura de nov, **outubro** (a maior parte do período). Considera as datas ajustadas: ajustar o fechamento recalcula o mês do gasto desta fatura e da seguinte; mover um item de fatura o leva para o mês do gasto da fatura nova (`syncChargeMonths`).
  - *Por quê (revisão de 12/11/2026):* antes era o mês da compra. Num cartão que fecha no fim do mês, a compra feita depois do fechamento ficava no mês anterior, junto com compras de outra fatura. A pessoa pensa na fatura como "os gastos do mês"; o período de compras resolve isso. A regra da maior parte do período evita jogar para o mês seguinte as compras de cartões que fecham no começo do mês. O pagamento da fatura é caixa, não gasto: não entra no consumo do mês (só em "Na conta até agora"). O "Saldo restante da fatura" fica fora do consumo; o "Ajuste da fatura" conta no mês da fatura (não no do período de compras: só existe depois do pagamento).
- **Itens no crédito não têm "Marcar como pago":** o status vem da fatura (`Fatura em aberto · nov`, `Fatura atrasada`, `Fatura paga`, `Fatura parcialmente paga`).
- **Pagar fatura:** a pessoa informa o **valor real** (do banco), o **valor pago** e a data.
  - Real ≠ soma dos itens → item de sistema **"Ajuste da fatura"** com a diferença (pode ser negativo). Um por fatura, recalculado.
  - Pago < real → **parcialmente paga**: o restante vira automaticamente o item **"Saldo restante da fatura <mês> · <cartão>"** na fatura seguinte e esta fica `carried` (encerrada), deixando de contar como atraso — o valor nunca conta duas vezes. Juros aparecem pelo ajuste da fatura seguinte.
  - Fatura paga ou encerrada não aceita outro pagamento (`invoice_closed`).
- **Desfazer pagamento:** remove o pagamento, o saldo transferido e o "Ajuste da fatura" e reabre a fatura; bloqueado se a fatura seguinte (que contém o saldo) já foi paga. O valor real informado fica guardado e volta preenchido no próximo pagamento. O ajuste não pode ser excluído à mão (deixaria a fatura paga com total diferente do banco): desfaz-se o pagamento.
- **Mover item de fatura:** só entre faturas abertas do mesmo cartão (anterior/seguinte na interface). O mês do gasto acompanha a fatura nova.
- **Bloco "Faturas do mês"** acima da tabela de despesas: uma linha por cartão com itens no mês, mais faturas **atrasadas** de meses anteriores quando o mês é o atual. Continua pelo vencimento e mostra o **período das compras** de cada fatura (`purchasesFrom` = fechamento da anterior, `purchasesTo` = véspera do fechamento), porque as compras dela aparecem na tabela nos meses em que foram feitas.

## Consequências
- Faturas vazias são criadas ao abrir o mês (uma por cartão ativo), mas só aparecem com itens ou pagamentos.
- A importação (ADR-0010) concilia o pagamento da fatura com a fatura (`payInvoice`), nunca como despesa.
- **Valor real antes do pagamento:** importar a fatura do banco grava o total em `real_amount_cents` da fatura aberta, sem pagá-la. O pagamento vem com esse valor preenchido ("Valor da fatura importada"), e o "Ajuste da fatura" continua nascendo no pagamento.
- **Datas do banco:** a importação pode ajustar fechamento e vencimento daquele mês, como o "ajustar" manual.
- **Compra parcelada antiga (`pastInstallmentsPaid`, ADR-0004):** no cadastro, cada fatura de mês anterior ao atual que recebeu uma parcela é paga (valor real = pago = total, na data do vencimento) **se estiver aberta, sem pagamentos e sem itens de outros lançamentos**. O critério não é "criada agora" porque abrir o mês já cria faturas vazias. Faturas passadas com outros itens continuam como estão, para não quitar em silêncio o que a pessoa ainda acompanha.
