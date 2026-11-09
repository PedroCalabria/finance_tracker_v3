## 1. Banco e contratos

- [x] 1.1 `schema.ts`: tabela `people` (id, wallet_id, name, archived_at, version, created_at; índice único `(wallet_id, lower(name))` entre as ativas; índice por carteira) e colunas `items.person_id` (→ people, `set null`) e `items.reimburses_item_id` (→ items, `set null`). Rodar `npm run db:generate` e commitar a migração em `apps/server/drizzle/`.
- [x] 1.2 `packages/shared/src/schemas.ts`:
  - `personInput`/`personUpdate` (nome de 1 a 60);
  - em `itemCreateInput`: `personId` (uuid nulo), `createReimbursement` (boolean) e `pastInstallmentsPaid` (boolean);
  - refinamentos: `createReimbursement` só em despesa e com `personId`; na recorrente fora do crédito, também com `day` ("Informe o dia: o reembolso usa o mesmo dia.");
  - em `itemEditInput`: `personId` (uuid nulo).
- [x] 1.3 `packages/shared/src/api-types.ts`:
  - `Person` (`id`, `name`, `archived`);
  - `person` em `OccurrenceRow` e `ItemDetail`;
  - `reimbursement`/`reimburses` em `ItemDetail`;
  - `forecastCents` em `Summary.income` e `Summary.expense`.

## 2. Regra pura do reembolso (`packages/shared`)

- [x] 2.1 Criar `packages/shared/src/reimbursement.ts` com `reimbursementInput(expense, firstCharge)`, seguindo a tabela do design. Exportar em `index.ts`.
- [x] 2.2 Testes unitários (`reimbursement.test.ts`), cobrindo:
  - única fora do crédito, com e sem data p/ pagamento;
  - única no crédito;
  - parcelada fora do crédito e no crédito;
  - recorrente fora do crédito (dia e "valor varia");
  - recorrente no crédito (mês da fatura e dia do vencimento);
  - método Pix e conta só fora do crédito.

## 3. Pessoas no servidor

- [x] 3.1 `domain/catalog.ts`: `listPeople`, `createPerson`, `renamePerson` e `removePerson` (apaga sem uso, arquiva em uso), com `duplicate` via `isUniqueViolation`, e `getPersonChecked` (mesma carteira; arquivada só se for a atual do item).
- [x] 3.2 `http/routes/wallet.ts`: `GET/POST /people`, `PATCH/DELETE /people/:id`, como as rotas de categorias.
- [x] 3.3 `domain/occurrences.ts` e `getItemDetail`: carregar `person` (por ids, sem `Promise.all` com `tx`) e, no detalhe, `reimbursement`/`reimburses`, ignorando itens excluídos.
- [x] 3.4 `createItemTx` grava `person_id`. Em `editItem`, `personId` é mudança simples (atualiza só o item, mesmo junto de uma estrutural). `rebuild`/`ruleFields` preservam `person_id` e `reimburses_item_id`.

## 4. Cadastro: reembolso e parcelas passadas (`domain/items.ts`)

- [x] 4.1 Parcelas de meses anteriores. Na parcelada com `pastInstallmentsPaid`, ignorando `alreadyPaid`:
  - fora do crédito: pagar as ocorrências com competência < mês atual, na data de vencimento;
  - no crédito: pagar com `payInvoiceTx` (real = pago = total, `paidAt` = vencimento) cada fatura passada aberta, sem pagamentos e sem ocorrências ativas de outros itens.
- [x] 4.2 Reembolso. Com `createReimbursement`, depois da despesa:
  - calcular `firstCharge` no crédito: 1ª ocorrência na única/parcelada; `slotFor`/`chargeMonthFor` no `startMonth` da recorrente;
  - achar ou criar a categoria de entrada "Gasto de terceiros";
  - chamar `createItemTx` com `reimbursementInput`, repassando `alreadyPaid`/`pastInstallmentsPaid`;
  - gravar `reimburses_item_id`.
- [x] 4.3 `deleteItem` com `withReimbursement`: exclusão lógica do reembolso não excluído, na mesma transação e depois da despesa. Na rota, ler `?withReimbursement=1`.

## 5. Resumo do mês

- [x] 5.1 `domain/summary.ts`: `income.forecastCents` = recebido + a receber; `expense.forecastCents` = pago + a pagar.
- [x] 5.2 `SummaryCards.tsx`: previsto como valor principal e realizado na linha de baixo, com os subtítulos e textos da spec `resumo-do-mes`.

## 6. Interface: componentes

- [x] 6.1 `Icon.tsx`: ícone `up`.
- [x] 6.2 `StepperInput` em `components/ui.tsx`:
  - só dígitos, setas empilhadas dentro da caixa (`tabIndex=-1`, `aria-label`, desabilitadas nos limites);
  - ↑/↓ do teclado, limites `min`/`max`;
  - estilo `app-stepper` em `app.css`, só com tokens.
- [x] 6.3 `PersonSelect` em `components/ui.tsx`: "Eu" opcional por prop, pessoas ativas em ordem alfabética (mais a atual, se arquivada), "+ Nova pessoa" com campo de nome e "Voltar". Em `lib/queries.ts`: `usePeople` e invalidação de `people`.

## 7. Interface: telas

- [x] 7.1 `CategoriesPage.tsx`: terceira opção "Pessoas" no seletor, com criar, renomear e remover/arquivar e as mensagens próprias.
- [x] 7.2 `ItemFormModal.tsx`:
  - seletor "Responsável" na entrada e na edição de despesa;
  - checkbox "Gasto de outra pessoa" no cadastro de despesa, com seletor sem "Eu" e obrigatório ("Escolha a pessoa.");
  - criar a pessoa nova antes do lançamento;
  - enviar `personId`/`createReimbursement`;
  - dia obrigatório na recorrente fora do crédito quando o checkbox está marcado;
  - mostrar o vínculo ("Reembolso: …" / "Reembolso de …").
- [x] 7.3 `ItemFormModal.tsx`:
  - na parcelada, trocar "Já foi pago?" por "As parcelas de meses anteriores já foram pagas/recebidas?" (padrão Sim), visível só quando a 1ª parcela cai antes do mês atual (fora do crédito, pelo mês da data; no crédito, pela prévia da fatura);
  - enviar `pastInstallmentsPaid`.
- [x] 7.4 `ItemFormModal.tsx`:
  - `methodTouched`: Parcelada → Crédito no cadastro de despesa quando há cartão e o método não foi mexido; voltar restaura Pix;
  - trocar o campo de parcelas por `StepperInput` (2–120, "Aumentar parcelas"/"Diminuir parcelas").
- [x] 7.5 `OccurrenceTable.tsx`:
  - coluna "Responsável" depois de Categoria (ordenável; "Eu" quando nulo);
  - `app-person-inline` embaixo da categoria abaixo de 1280px;
  - nome no kicker do card no celular quando não é "Eu";
  - subgrid com `colSpan` 11;
  - CSS em `app.css`.
- [x] 7.6 `EditOccurrenceModal.tsx` e `DeleteRecurringDialog.tsx`: quando o item tem `reimbursement`, checkbox "Excluir também o reembolso" (marcado) em "Excluir" e em "Toda a recorrência", chamando `DELETE /items/:id?withReimbursement=1`.

## 8. Testes de integração (`apps/server/test`)

- [x] 8.1 Pessoas:
  - criar, listar, renomear e duplicar (`duplicate`);
  - remover sem uso (apaga) e em uso (arquiva e continua nas linhas);
  - acesso de quem não é membro;
  - `personId` de outra carteira recusado.
- [x] 8.2 Responsável:
  - cadastro com e sem pessoa;
  - troca na edição sem recriar meses (pagamentos preservados);
  - edição estrutural mantém a pessoa.
- [x] 8.3 Reembolso:
  - os seis casos da tabela de datas (inclusive os cenários de crédito da spec);
  - categoria criada uma vez e reaproveitada;
  - rollback quando o cadastro falha;
  - recusas de validação (entrada, sem pessoa, recorrente sem dia);
  - editar a despesa não muda o reembolso;
  - excluir com e sem `withReimbursement`;
  - cancelar parcelas não mexe no reembolso.
- [x] 8.4 Parcelas passadas:
  - boleto com meses anteriores pagos e mês atual em aberto;
  - resposta "Não";
  - compra nova;
  - crédito pagando só faturas passadas sem outros itens (e não a que tinha outra compra);
  - reembolso seguindo a mesma resposta;
  - `alreadyPaid` ignorado na parcelada.
- [x] 8.5 Resumo: `forecastCents` de entradas e gastos, inclusive com atrasados no mês atual.

## 9. Documentação e verificação

- [x] 9.1 ADR-0004:
  - pessoas e responsável;
  - reembolso (mapeamento, vínculo, exclusão);
  - "Já foi pago?" na parcelada → `pastInstallmentsPaid`;
  - cards (previsto em destaque, `forecastCents`).
- [x] 9.2 ADR-0005: pagamento automático das faturas passadas no cadastro com `pastInstallmentsPaid`.
- [x] 9.3 ADR-0009:
  - aba Pessoas;
  - coluna Responsável (11 colunas, recolhida abaixo de 1280px);
  - `StepperInput` e `PersonSelect` como acréscimos que devem voltar ao artifact do design system;
  - Parcelada abre no Crédito;
  - cards.
- [x] 9.4 `docs/PROGRESS.md`: seção "Ajustes de <data>" com as seis melhorias e a contagem de testes atualizada.
- [x] 9.5 Rodar `npm run typecheck`, `npm test` e `npm run build`. Roteiro no navegador em 1440px, 1920px, 900px e celular, claro e escuro:
  - cadastro de gasto de terceiro no crédito (reembolso criado);
  - compra antiga parcelada no boleto e no crédito;
  - setas das parcelas;
  - cards;
  - coluna Responsável;
  - sem rolagem horizontal.
