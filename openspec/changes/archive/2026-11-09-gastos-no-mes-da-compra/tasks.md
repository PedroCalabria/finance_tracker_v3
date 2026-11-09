## 1. Regra pura e contratos (`packages/shared`)

- [x] 1.1 Regra pura `chargeMonthOf({ purchaseDate, installment, firstChargeMonth? })` para única e parcelada no crédito (mês da compra + k − 1; `firstChargeMonth` para as parcelas importadas), exportada em `index.ts`.
- [x] 1.2 Testes unitários: única, parcela k, virada de ano, `firstChargeMonth` de "PARC 05/10".
- [x] 1.3 `api-types.ts`: `OccurrenceRow.chargeMonth`; `InvoiceRow.purchasesFrom`/`purchasesTo`.
- [x] 1.4 `reimbursementInput(expense)` sem `firstCharge`: no crédito, data da compra (única e parcelada) e dia da cobrança (recorrente, mesmo mês de início). Atualizar `reimbursement.test.ts`.

## 2. Banco e backfill

- [x] 2.1 `schema.ts`: `occurrences.charge_month` (char(7), not null) e índice `(wallet_id, charge_month)`. Rodar `npm run db:generate` e renomear a migração para `0003_mes_do_gasto`.
- [x] 2.2 Editar o SQL gerado:
  - adicionar a coluna nula;
  - preencher `charge_month = competence_month`;
  - recalcular o crédito: única pela `entry_date`; parcela pela `entry_date` + (n − 1), com a regra "mais de 2 meses antes ou depois da fatura → mês anterior ao da fatura"; recorrente pela data de fechamento da fatura;
  - `set not null`;
  - criar o índice.
- [x] 2.3 Conferir o backfill numa cópia do banco de desenvolvimento (amostra de compra única, parcelada, recorrente e importada) e registrar o resultado.

## 3. Gravação do mês do gasto (servidor)

- [x] 3.1 `writeOccurrences`:
  - `chargeMonth` em cada linha planejada (fora do crédito = competência; crédito via `chargeMonthOf`);
  - opção `firstChargeMonth` em `createItemTx`;
  - as linhas reaproveitadas na edição estrutural também recebem o valor.
- [x] 3.2 `projections.ts`:
  - `insertSlot` grava `slot.chargeMonth`;
  - `ensureMaterialized` grava os slots com `chargeMonth ≤ mês atual` (em vez da competência);
  - `projectionsFor` ganha o modo por mês do gasto (só meses > atual), e o modo por competência continua para `projectedCreditCharges`;
  - `materializeProjection` e o id `p_<itemId>_<competência>` não mudam.
- [x] 3.3 `rebuild` (recorrente): as ocorrências preservadas recebem `charge_month` do slot. `patchOccurrence`: fora do crédito, mudar `competenceMonth` muda `charge_month` junto. Mover de fatura não muda.
- [x] 3.4 Itens de sistema da fatura ("Ajuste" e "Saldo restante"): `charge_month` = mês de referência da fatura.
- [x] 3.5 Importação de fatura (`createFromInvoice`): `firstChargeMonth = mês da compra + (n − 1)` em "PARC n/m".
- [x] 3.6 Reembolso no cadastro (`createReimbursement`): sem `firstCharge`, usando a nova `reimbursementInput`.

## 4. Leitura pelo mês do gasto (servidor)

- [x] 4.1 `listOccurrences`: filtrar por `charge_month` (mais os atrasados fora do crédito no mês atual) e incluir as projeções por mês do gasto. `buildRows`/`projectedRow` trazem `chargeMonth`.
- [x] 4.2 `getItemDetail` (recorrente): meses gravados com `charge_month ≤ mês atual`, mais a projeção do próximo mês do gasto.
- [x] 4.3 `monthsRange`: mínimo e máximo entre `charge_month` e `competence_month`.
- [x] 4.4 `toInvoiceRow`: `purchasesFrom` (fechamento da fatura anterior, gravada ou padrão) e `purchasesTo` (fechamento − 1 dia).
- [x] 4.5 `summary.ts`:
  - gastos por consumo, a partir das linhas por mês do gasto: crédito pago se a fatura está paga ou encerrada; sem "Saldo restante" e sem canceladas; `lateCents` só fora do crédito;
  - `realizedCents` como hoje (caixa);
  - `balance.forecastCents` = entradas − gastos previstos.

## 5. Interface

- [x] 5.1 `SummaryCards.tsx`: subtítulo do Balanço "Entradas menos gastos do mês" e linha "Na conta até agora: R$ …".
- [x] 5.2 `InvoicesBlock.tsx`: "compras de dd/mm a dd/mm" embaixo do nome do cartão.
- [x] 5.3 `OccurrenceTable.tsx`: na subgrid de recorrentes, coluna "Mês" pelo `chargeMonth`.
- [x] 5.4 `ItemFormModal.tsx`: aviso da fatura no crédito passa a "Conta como gasto de nov/2026. Vai para a fatura de dez/2026, que vence em 01/12/2026." (nas parceladas, "… e as outras parcelas nos meses seguintes").

## 6. Testes de integração (`apps/server/test`)

- [x] 6.1 Atualizar os testes que esperam compras no crédito na tabela do mês da fatura (`finance.test.ts`, `delete-recurring.test.ts`, `recurring-installments.test.ts`, `imports.test.ts`, `people-reimbursement.test.ts`), sem mudar as asserções sobre faturas.
- [x] 6.2 Teste novo (`charge-month.test.ts`), cobrindo:
  - os cenários da spec `mes-do-gasto`: única antes e depois do fechamento, parcelada, "PARC 05/10" importada, mover de fatura, recorrente cobrada no fim do mês (gravada no mês da cobrança, prevista no seguinte), "Só este mês", período das compras e navegação;
  - os cenários da spec `resumo-do-mes`: consumo × caixa, saldo transferido fora, ajuste dentro, atraso só fora do crédito;
  - o reembolso no crédito no mês da compra.
- [x] 6.3 Teste do backfill: rodar as migrações até a `0002`, inserir uma amostra (única, parcelada, recorrente e importada no crédito; uma fora do crédito), aplicar a `0003` e conferir o `charge_month`.

## 7. Documentação e verificação

- [x] 7.1 ADR-0004:
  - "Mês da ocorrência" ganha o mês do gasto;
  - "Cards do mês" passa a consumo × caixa;
  - "Recorrentes" passa a gravar pela cobrança;
  - reembolso no mês da compra.
- [x] 7.2 ADR-0005: dois meses no crédito (gasto × fatura), período das compras no bloco e "Saldo restante" fora do consumo.
- [x] 7.3 ADR-0009: tabela pelo mês do gasto (com selo da fatura), período das compras, textos dos cards e aviso do cadastro.
- [x] 7.4 `docs/PROGRESS.md` (e a contagem de testes no README).
- [x] 7.5 Rodar `npm run typecheck`, `npm test` e `npm run build`. Roteiro no navegador em 1440px, 1920px, 900px e celular, claro e escuro, com banco descartável:
  - compra no cartão aparecendo no mês da compra com o selo da fatura;
  - bloco de faturas com o período;
  - cards (consumo × "Na conta até agora");
  - recorrente no crédito;
  - reembolso no mesmo mês.
