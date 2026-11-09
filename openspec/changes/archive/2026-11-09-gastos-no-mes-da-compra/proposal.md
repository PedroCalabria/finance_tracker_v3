## Why

O objetivo do app é mostrar quanto a pessoa **gastou** em cada mês, para comparar com o que recebe. Hoje cada ocorrência tem um único mês, o `competence_month`. No crédito, esse mês é o do **vencimento da fatura** (ADR-0005). Com vencimento no começo do mês, que é o caso mais comum, quase toda compra pula um mês e às vezes dois: uma compra de 27/11 num cartão que fecha no dia 25 e vence no dia 1 aparece em janeiro.

O card "Gastos do mês" também soma as faturas que vencem no mês. Por isso ele mostra a saída de caixa, não o consumo, e o mês da compra parece mais leve do que foi.

## What Changes

- **Mês do gasto.** Cada ocorrência ganha um segundo mês, o **mês do gasto** (`charge_month`): o mês em que a compra ou cobrança aconteceu.
  - Fora do crédito, é igual ao `competence_month`.
  - No crédito, é o mês da compra. Na parcelada, a parcela k fica k−1 meses depois. Na recorrente, é o mês da cobrança.
  - O `competence_month` continua sendo o mês da fatura. Faturas, atrasos, lembretes, importação, mover de fatura, exclusão de recorrente e edição estrutural continuam usando ele.
- **Tabela e navegação.** A tabela de despesas e a navegação entre meses passam a usar o mês do gasto. A linha no crédito mantém o selo e a data de vencimento da fatura, para a pessoa saber quando paga.
- **Recorrentes no crédito.** A ocorrência passa a ser gravada quando a **cobrança** chega (mês do gasto ≤ mês atual), e não quando a fatura chega. Os meses de cobrança futuros continuam como projeções.
- **Bloco "Faturas do mês".** Continua por vencimento e passa a mostrar o período das compras de cada fatura ("compras de 26/09 a 25/10").
- **Cards do mês.**
  - "Gastos do mês" passa a ser o **consumo**: despesas fora do crédito do mês mais compras no crédito com mês do gasto no mês. Ficam de fora os pagamentos de fatura, para não contar duas vezes, e o "Saldo restante da fatura", que não é gasto novo.
  - O Balanço previsto vira entradas do mês − gastos do mês.
  - A linha de baixo do Balanço passa a "Na conta até agora": o que entrou menos o que saiu da conta, que é o `realizedCents` de hoje.
  - **BREAKING (comportamento):** os valores de "Gastos do mês" e do Balanço previsto mudam para quem usa crédito.
- **Reembolso de terceiros no crédito.** Passa a usar a data da compra, como fora do crédito. Assim o balanço do mês zera para aquele gasto.
- **Migração.** Uma migração com backfill calcula o mês do gasto dos lançamentos existentes.

## Capabilities

### New Capabilities
- `mes-do-gasto`: o mês do gasto de cada ocorrência (regra, gravação e backfill); a tabela, as recorrentes previstas e a navegação por esse mês; o período das compras no bloco de faturas.

### Modified Capabilities
- `resumo-do-mes`: o previsto de gastos passa a ser o consumo (mês do gasto, sem pagamentos de fatura nem saldo transferido); a linha de baixo do Balanço passa a ser "Na conta até agora" (caixa).
- `reembolso-de-terceiros`: no crédito, as datas do reembolso passam a ser as da compra, e não as do vencimento da fatura.

## Impact

- **Banco:**
  - coluna nova `occurrences.charge_month`, com índice por carteira e mês;
  - migração com backfill, incluindo a regra de recorrentes no crédito pela data de fechamento da fatura.
- **Compartilhado:**
  - regra pura do mês do gasto, em `schedule.ts` ou num módulo próprio, com testes;
  - `reimbursementInput` sem `firstCharge`;
  - `OccurrenceRow.chargeMonth`;
  - `InvoiceRow` com o período das compras.
- **Servidor:**
  - `domain/items.ts` (`writeOccurrences`, `rebuild`, patch de mês fora do crédito);
  - `domain/projections.ts` (materializar por cobrança, projeções por mês do gasto);
  - `domain/occurrences.ts` (filtro por mês do gasto);
  - `domain/summary.ts` (consumo e caixa);
  - `domain/invoices.ts` (período das compras; itens de sistema com mês do gasto);
  - `domain/imports/confirm.ts` (parcelas antigas da fatura).
- **Interface:**
  - `SummaryCards.tsx` (textos);
  - `InvoicesBlock.tsx` (período das compras);
  - `OccurrenceTable.tsx` (mês da subgrid de recorrentes no crédito);
  - `ItemFormModal.tsx` (aviso da fatura no cadastro de crédito, que passa a dizer que o gasto conta no mês da compra).
- **Testes:**
  - os de integração que esperam compras no crédito no mês da fatura (`finance.test.ts`, `delete-recurring.test.ts`, `recurring-installments.test.ts`, `imports.test.ts`, `people-reimbursement.test.ts`) passam a esperar o mês do gasto na tabela;
  - as regras de fatura não mudam.
- **Docs:** ADR-0004, ADR-0005, ADR-0009 e `docs/PROGRESS.md`.
