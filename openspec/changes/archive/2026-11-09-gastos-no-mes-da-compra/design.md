## Context

**Um mês só por ocorrência.** Cada ocorrência tem um único mês, o `competence_month`:
- fora do crédito, é o mês da data p/ pagamento ou da data;
- no crédito, é o mês de **vencimento da fatura** (ADR-0005).

Esse mês é usado em todos os lugares:
- na tabela (`listOccurrences`);
- nos cards (`summary.ts`);
- na navegação (`monthsRange`);
- nas projeções de recorrentes (`projectionsFor`, que só projeta meses futuros e filtra pela competência);
- na gravação preguiçosa das recorrentes (`ensureMaterialized`, que grava os meses com competência ≤ mês atual);
- no id das projeções (`p_<itemId>_<competência>`);
- nas faturas;
- na importação;
- na exclusão de recorrente;
- na edição estrutural (`paidTargets`).

Só no servidor, são 79 pontos.

**O mês da cobrança já existe parcialmente.** `slotFor` devolve `chargeMonth` (o mês da cobrança) e `competenceMonth` (o da fatura) para recorrentes. `chargeMonthFor` faz o caminho inverso. Nas compras únicas e parceladas, o mês da compra só existe implícito, em `items.entry_date`.

**Exceção da importação.** A importação de fatura cria as parcelas antigas ("PARC 05/10") como uma parcelada com as parcelas restantes. A data é a da compra original, e a 1ª ocorrência é forçada na fatura importada (`invoiceMonth`).

**Cards de hoje.**
- "Gastos": pula as ocorrências no crédito e soma as faturas do mês (pagas → pago; abertas → a pagar).
- "Realizado": recebido − (pagamentos de ocorrências do mês fora do crédito + pagamentos das faturas do mês), ou seja, caixa.

**Itens de sistema da fatura.**
- "Ajuste da fatura" é a diferença entre o valor real e a soma dos itens (juros, tarifas, IOF).
- "Saldo restante da fatura" é o que ficou de uma fatura paga em parte. Ele não é gasto novo.

## Goals / Non-Goals

**Goals:**
- O mês exibido de uma compra no crédito é o mês em que ela aconteceu, para comparar gasto × recebido no mesmo mês.
- Não mexer no que depende do mês da fatura: faturas, atrasos, lembretes, importação, mover de fatura, exclusão de recorrente e edição estrutural.
- Não contar duas vezes: a compra conta no mês do gasto, e o pagamento da fatura não conta como gasto.
- Manter a visão de caixa onde ela ajuda: bloco de faturas e "Na conta até agora".

**Non-Goals:**
- Chave para alternar entre as visões, relatórios e orçamento por categoria.
- Mudar regras de fatura (compra × fechamento, ajuste, saldo transferido).
- Mudar o id das projeções.

## Decisions

### 1. Coluna nova `charge_month`, sem mudar o sentido de `competence_month`
`occurrences.charge_month char(7) not null`, com o índice `(wallet_id, charge_month)`.

- *Alternativa: `competence_month` passar a ser o mês da compra.* Mexeria nos 79 pontos e nas regras de fatura (`invoice_id` × mês), na importação e na edição estrutural. O risco é alto para um ganho que é só de leitura.
- *Alternativa: calcular na consulta.* Filtrar por mês em SQL exige o valor gravado. As parcelas importadas e as recorrentes no crédito não são deriváveis com uma expressão simples.

**Regra.** Toda escrita que define `competence_month` fora do crédito define `charge_month` igual. Os caminhos são:
- `writeOccurrences`;
- `insertSlot`;
- `patchOccurrence`, quando muda o mês da única;
- a normalização das recorrentes preservadas em `rebuild`.

"Mover de fatura" muda só a competência.

### 2. Regra pura do mês do gasto (`packages/shared`)
`chargeMonthOf({ method, purchaseDate, installment, firstChargeMonth? })`:
- fora do crédito: não se aplica, porque o servidor usa a competência;
- crédito, única: `monthOf(purchaseDate)`;
- crédito, parcela k: `addMonths(firstChargeMonth ?? monthOf(purchaseDate), k − 1)`.

Na importação de "PARC n/m", `firstChargeMonth = addMonths(monthOf(dataDaCompra), n − 1)`. A importação passa esse valor em `createItemTx(..., { invoiceMonth, firstChargeMonth })`. Recorrentes usam o `chargeMonth` de `slotFor`.

Itens de sistema:
- "Ajuste" e "Saldo restante": `charge_month` = mês de referência da fatura;
- o "Saldo restante" fica fora do consumo pelo `system_kind`, que já existe (sem flag nova).

### 3. Recorrentes no crédito: gravar quando a cobrança chega
`ensureMaterialized` passa a gravar os slots com `chargeMonth ≤ mês atual`, em vez de `competenceMonth ≤ mês atual`.

A cobrança de 28/11 já aconteceu em novembro e deve aparecer em novembro como real (pagável pela fatura, excluível como "Só este mês"), mesmo que a fatura seja de janeiro. Gravar cria a fatura futura sob demanda (`ensureInvoice`), como qualquer compra.

Consequências:
- **Projeções (`projectionsFor`) para a tabela:** só existem para mês do gasto > mês atual. A função ganha o modo "por mês do gasto", que filtra `slot.chargeMonth === month`. O modo "por competência" continua, usado por `projectedCreditCharges` no total previsto das faturas futuras.
- **O id da projeção continua `p_<itemId>_<competência>`.** Assim, `materializeProjection`, a exclusão "Só este mês" e a importação não mudam.
- **`getItemDetail` das recorrentes:** filtra os meses gravados por `charge_month ≤ mês atual`, mais a projeção do próximo mês do gasto.

- *Alternativa: manter a gravação pela competência e listar projeções também no passado.* Exigiria projeções de meses passados e presentes, com ações escondidas, e o mês corrente teria linhas "Previsto" já cobradas.

### 4. Tabela e navegação pelo mês do gasto
- **`listOccurrences`:** filtra `charge_month = mês`. No mês atual, os atrasados fora do crédito continuam entrando (`competence_month < mês`, em aberto, sem fatura); fora do crédito, os dois meses são iguais. Os demais filtros não mudam.
- **`monthsRange`:** usa `least(min(charge_month), min(competence_month))` e o máximo correspondente, com a regra dos 6 meses à frente.
- **Linha no crédito:** continua com o selo "Fatura em aberto · dez" e a data de vencimento da fatura.
- **Subgrid de recorrentes no crédito:** a coluna "Mês" passa a mostrar o mês do gasto.

### 5. Bloco de faturas com o período das compras
`InvoiceRow` ganha `purchasesFrom` e `purchasesTo`:
- `purchasesFrom` = fechamento da fatura anterior do cartão (gravada ou padrão);
- `purchasesTo` = fechamento desta − 1 dia.

A interface mostra "compras de 26/09 a 25/10" embaixo do nome do cartão. O total da fatura continua o mesmo.

### 6. Resumo: consumo no previsto, caixa no realizado
O consumo do mês M vem das linhas de `listOccurrences(M)`: gravadas e projetadas, por mês do gasto.

| Linha | Pago | A pagar |
| --- | --- | --- |
| Fora do crédito | Os pagamentos | O restante (inclusive os atrasados do mês atual, como hoje) |
| No crédito, fatura `paid` ou `carried` | O previsto | — |
| No crédito, fatura `open` ou prevista | — | O previsto |
| "Saldo restante da fatura" | Fora | Fora |
| Cancelada | Fora | Fora |

- `expense.forecastCents` = pago + a pagar.
- `expense.lateCents` passa a ser **só fora do crédito**. Fatura atrasada já aparece no bloco de faturas, e as compras dela foram contadas nos meses em que aconteceram.

O caixa continua com a regra de hoje: `balance.realizedCents` = recebido − (pagamentos das ocorrências do mês fora do crédito + pagamentos das faturas que vencem no mês). O resultado é o mesmo número de hoje, com o rótulo "Na conta até agora".

`balance.forecastCents` = `income.forecastCents − expense.forecastCents` (consumo).

- *Alternativa: realizado por consumo.* No mês corrente, quase todo crédito apareceria "a pagar", e a linha deixaria de responder "quanto dinheiro saiu".

### 7. Reembolso de terceiros
`reimbursementInput(expense)`, sem `firstCharge`. No crédito, usa as datas da compra:
- única e parcelada: `date` = data da compra;
- recorrente: mesmo `startMonth` e `day` = dia da cobrança.

A entrada não é crédito, então o mês do gasto dela é a competência, o mesmo mês da despesa.

### 8. Backfill (SQL na migração)
- Adiciona a coluna nula e preenche `charge_month = competence_month`.
- Para as ocorrências de itens no crédito, recalcula:
  - **única** (sem `system_kind`): mês de `entry_date`, com a mesma checagem de intervalo da parcelada. A última parcela antiga importada ("PARC 06/06") é gravada como única com a data da compra original;
  - **parcelada:** mês de `entry_date` + (`installment_number` − 1). Se o resultado ficar **mais de 2 meses antes** da competência, ou **depois** dela, é parcela antiga importada da fatura (ou ocorrência movida à mão), e o valor passa a ser competência − 1;
  - **recorrente:** pela data de fechamento da fatura da ocorrência. Se o dia da cobrança (`entry_date`, limitado ao último dia do mês) no mês do fechamento cai **antes** do fechamento, o mês do gasto é o do fechamento; senão, é o mês anterior a ele. Sem fatura, vale competência − 1;
  - **itens de sistema:** a competência (já preenchida).
- Por fim, `set not null` e o índice.

A regra pura (Decisão 2) é a referência. O SQL replica só os três casos acima, e o roteiro de verificação confere uma amostra no banco de desenvolvimento.

## Risks / Trade-offs

- **[A soma das linhas de crédito do mês não bate com a fatura do mês]** → É o efeito pretendido. O bloco de faturas mostra o período das compras e cada linha mostra o mês da fatura.
- **[Backfill aproximado nas parcelas antigas importadas]** → Ficam no mês anterior ao da fatura, que é o mais provável. É só exibição: valores e faturas não mudam.
- **[Gravar recorrentes no crédito pela cobrança cria faturas futuras antes]** → As faturas são criadas sob demanda e uma fatura sem pagamento não aparece como atrasada. O total previsto das faturas futuras passa a contar a ocorrência gravada no lugar da projeção, com o mesmo valor.
- **[Mudança de números nos cards para quem usa crédito]** → É intencional. O ADR-0004 e o PROGRESS registram a mudança.
- **[Testes de integração que assumem o mês da fatura na tabela]** → São atualizados. Os de fatura não mudam.

## Migration Plan

1. `schema.ts`: nova coluna e índice. `npm run db:generate` gera a migração.
2. Acrescentar o backfill no SQL gerado, antes do `not null`.
3. **Deploy:** a migração roda no início (com o advisory lock existente).
4. **Reversão:** voltar a imagem anterior. A coluna a mais não atrapalha o código antigo; se preciso, uma migração de remoção.

## Open Questions

Nenhuma bloqueante.
