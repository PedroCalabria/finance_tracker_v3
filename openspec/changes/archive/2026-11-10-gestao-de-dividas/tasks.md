## 1. Matemática pura (`packages/shared/src/debts/`)

- [x] 1.1 `rates.ts`: `annualToMonthlyPpm`, `monthlyPpmToAnnual` e `monthInterest(balanceCents, ratePpm)`, com arredondamento meio para cima.
- [x] 1.2 `contract.ts`:
  - `pricePayment(B, ppm, n)` e `priceTerm(B, ppm, P)`, com o caso i = 0;
  - `sacAmortization(B, n)`;
  - `recalcAfterExtra(structure, contrato, saldoAntes, saldoDepois, effect)`.
- [x] 1.3 `balance.ts`:
  - `estimateBalance(anchor, ppm, payments, date)`: pagamentos ≤ data da âncora ignorados, juros no início de cada mês seguinte, piso zero;
  - `remainingInstallments(contract, contractAsOf, payments)`.
- [x] 1.4 `order.ts`: avalanche, bola de neve e manual, com os desempates da spec.
- [x] 1.5 `simulate.ts`:
  - `simulatePlan`, com mês 0 sem juros e obrigatório restante;
  - meses seguintes com juros → obrigatórios → sobra em cascata, pulando quem não aceita extra;
  - bola de neve;
  - limite de 600 meses;
  - avisos `budget_short`, `not_decreasing`, `no_budget` e `never_paid_off`;
  - timeline por dívida.
- [x] 1.6 `compare.ts`: as quatro estratégias. "Só o mínimo" sem sobra e sem rolar parcelas; "Minha ordem" cai na avalanche quando nunca foi gravada. `whatIf.ts`: sem amortizar × reduzir prazo × reduzir parcela; um resultado só no Rotativo e no Sem juros.
- [x] 1.7 Testes unitários com os valores das specs:
  - 12% a.a. → `9489`;
  - Price 2% (R$ 5.000, extra R$ 2.000): 7 parcelas, ou parcela de R$ 306,54 com 11;
  - saldo estimado (R$ 1.000 a 10% + pagamento de R$ 300 = R$ 800);
  - pagamento antes da âncora;
  - cenário da bola de neve A/B;
  - pagamento já registrado no mês 0;
  - consignado pulado;
  - rotativo 14%/10% com `not_decreasing`;
  - 600 meses;
  - "só o mínimo" que não rola parcelas;
  - virada de ano.
- [x] 1.8 Exportar em `packages/shared/src/index.ts`.

## 2. Contratos da API (`packages/shared`)

- [x] 2.1 `schemas.ts`:
  - `debtInput`, com campos por estrutura, credor exclusivo, Pessoa exige pessoa, Sem juros com taxa 0 e limites de taxa, parcela e dia;
  - `debtAnchorInput`, `debtPaymentInput` (efeito obrigatório no extra em Price/SAC, contrato opcional);
  - `debtPayOffInput`, `debtOrderInput`, `debtSettingsInput`, `debtBudgetInput`.
- [x] 2.2 `api-types.ts`: `DebtRow` (saldo estimado, saldo inicial, pago, parcelas restantes, âncora vigente), `DebtDetail`, `DebtPlan` (resumo, por dívida, timeline, comparação, avisos, planejado × destinado) e `DebtBudget`.

## 3. Banco

- [x] 3.1 `schema.ts`: `debts`, `debt_balance_anchors`, `debt_payments`, `debt_budgets` e `debt_settings`, conforme a Decisão 8 do design (checks, índices e único `(debt_id, date)`).
- [x] 3.2 `npm run db:generate`, renomear para `0004_dividas.sql`, conferir o SQL e commitar a migração e o `meta`.

## 4. Domínio e rotas (servidor)

- [x] 4.1 `domain/debts.ts`: CRUD de dívidas com a primeira âncora na mesma transação, `contract_as_of`, `position = max + 1`, `version` e exclusão lógica. Valida a Pessoa da carteira (ativa, ou a atual na edição).
- [x] 4.2 Âncoras: upsert por data, data ≤ hoje (`clock.today`), contrato opcional em Price/SAC e `last_anchor` ao excluir a única.
- [x] 4.3 Pagamentos: criar, editar e excluir com `version`. `debt_not_active`, `extra_not_allowed`, e contrato recalculado gravado com o pagamento na mesma transação.
- [x] 4.4 Quitar (com pagamento final opcional) e reabrir (no fim da ordem).
- [x] 4.5 Configurações e ordem: `debt_settings` com padrão avalanche; a primeira vez em `manual` inicializa as posições pela avalanche; `PUT /debts/order` valida a lista exata das ativas.
- [x] 4.6 Orçamento: listar, gravar e remover vigências.
- [x] 4.7 `GET /debt-plan`: carrega os dados sem `Promise.all` dentro de `tx`, estima os saldos e o já pago no mês, roda a simulação da estratégia e a comparação, e monta o planejado × destinado (últimos 12 meses, sem dívidas excluídas).
- [x] 4.8 Registrar as rotas em `http/routes/wallet.ts` sob `/api/wallets/:walletId`, com os códigos de `AppError` novos.

## 5. Testes de integração (`apps/server/test/debts.test.ts`)

- [x] 5.1 Autorização por membro da carteira e isolamento: nenhuma ocorrência criada; pagar um lançamento do mês não muda a dívida.
- [x] 5.2 Cadastro e validações: Price sem parcela, Sem juros com taxa, credor duplo, Pessoa sem pessoa, taxa acima do limite e troca de estrutura que limpa campos.
- [x] 5.3 Âncoras (substituir na mesma data, data futura, `last_anchor`) e saldo estimado com o relógio do teste.
- [x] 5.4 Pagamentos: antes da âncora; parcelas restantes que diminuem; extra com contrato gravado; `extra_not_allowed`; `debt_not_active`; editar e excluir sem reverter o contrato.
- [x] 5.5 Quitar com e sem pagamento final, reabrir no fim da ordem, excluir e o destinado.
- [x] 5.6 Orçamento (vigências e mês sem orçamento) e planejado × destinado com dívida quitada.
- [x] 5.7 Plano: ordem manual inicializada pela avalanche, lista incompleta (400), avisos e comparação. Conflito de `version` (409).

## 6. Interface

- [x] 6.1 Rota `/dividas` em `App.tsx` e item "Dívidas" no menu principal depois de "Importar" (`AppShell`, com ícone existente ou novo em `Icon.tsx`).
- [x] 6.2 `lib/queries.ts`: consultas e mutações do módulo com chaves por carteira e `invalidateDebts`.
- [x] 6.3 `DebtsPage`: estado vazio, cards de resumo, avisos, seção de orçamento (planejado × destinado), lista com seletor de estratégia e seção "Quitadas" recolhível.
- [x] 6.4 `DebtList`: dados da dívida, barra `app-progress` com `role="progressbar"`, selo "Não aceita amortização", ações, ↑↓ só em "Minha ordem" com rótulos acessíveis, e detalhes com o histórico de saldos e pagamentos.
- [x] 6.5 `DebtFormModal`:
  - campos por estrutura e padrões por categoria (sem sobrescrever o que a pessoa mudou);
  - taxa a.m./a.a. com a mensal exibida, e ajudas (CET, TR/IPCA);
  - aviso de rotativo no cartão;
  - credor em texto ou seletor de pessoas com "+ Nova pessoa";
  - primeira âncora.
- [x] 6.6 `DebtPaymentModal` (valor padrão, tipo, efeito, contrato recalculado editável, aviso "já considerado no saldo") e `BalanceAnchorModal`. Aviso ao editar ou excluir amortização extra.
- [x] 6.7 `WhatIfModal` com a regra pura no navegador, validação do valor e "Registrar esta amortização". `BudgetModal` com `MonthInput` e a lista de vigências.
- [x] 6.8 `DebtTimeline` em SVG: faixa por dívida, rótulo direto, marca de quitação, eixo em meses ou anos, `role="img"` e lista em texto. `StrategyCompare` com a frase da diferença.
- [x] 6.9 `app.css`: `app-progress`, `app-timeline` e o layout da tela só com tokens. Cards abaixo de 1024px, botão flutuante e modais da base abaixo de 768px.

## 7. Documentação e verificação

- [x] 7.1 `docs/decisions/0011-dividas.md`: modelo, âncora, taxa em ppm, simulação, estratégias, isolamento e o custo do vínculo futuro. Índice em `docs/decisions/README.md`.
- [x] 7.2 ADR-0009: rota `/dividas`, menu, timeline e os acréscimos `app-progress`/`app-timeline` que devem voltar ao artifact.
- [x] 7.3 `docs/PROGRESS.md`: etapa entregue, contagem de testes e pendências (vínculo, aportes, indexadores).
- [x] 7.4 `npm run typecheck`, `npm test` e `npm run build` passando.
- [x] 7.5 Roteiro no navegador em 1440px, 900px e celular, claro e escuro: cadastrar Price, Rotativo e Pessoa; registrar parcela e extra; atualizar saldo; trocar a estratégia e reordenar; simular amortização; quitar e reabrir. Sem rolagem horizontal.
