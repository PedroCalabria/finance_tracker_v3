## Context

O app registra os lançamentos de cada mês: itens, ocorrências, pagamentos e faturas (ADR-0004, ADR-0005). Empréstimos e financiamentos já aparecem como parceladas, e o rotativo do cartão aparece como "Saldo restante da fatura". Nada disso guarda saldo devedor, taxa ou ordem de prioridade.

O ledger tem regras delicadas: projeções `p_<itemId>_<mês>`, `paidTargets` na edição estrutural e o mês do gasto. Uma integração precoce com ele custaria caro e arriscaria regressões. Esta mudança cria um **módulo isolado**: tabelas próprias, matemática pura em `packages/shared` e uma tela nova. O desenho deixa o vínculo futuro com a tabela do mês possível sem migrar dados.

Restrições do projeto:
- dinheiro em centavos inteiros;
- datas e meses como string;
- regra pura com teste unitário em `packages/shared` e regra com banco com teste de integração;
- rotas sob `/api/wallets/:walletId` com autorização por membro;
- `AppError` com código estável;
- só `ff-*` e tokens na interface;
- migração gerada pelo drizzle-kit.

## Goals / Non-Goals

**Goals:**
- Cadastrar dívidas com a estrutura de pagamento correta (Price, SAC, Rotativo, Sem juros) e uma taxa mensal exata (inteiro).
- Manter o saldo sem reproduzir o cálculo do banco: âncoras informadas pela pessoa mais uma estimativa mês a mês.
- Registrar pagamentos e amortizações extras, com o recálculo do contrato.
- Orçamento com histórico; planejado × destinado.
- Simulação determinística e testável: avalanche, bola de neve, ordem manual e só o mínimo, com timeline e comparação.
- Esquema pronto para o vínculo com o ledger.

**Non-Goals:**
- Vínculo com a tabela do mês (`debts.item_id`, `debt_payments.occurrence_id`) e a operação "cancelar as N últimas parcelas".
- Indexadores reais (TR/IPCA), IOF, seguros, multa e mora, teto de 100% do rotativo.
- Juros diários ou pró-rata por dia: o passo é mensal.
- Aportes pontuais (13º), lembretes por email, sugestão de portabilidade, arrastar para reordenar.

## Decisions

### 1. Módulo isolado, sem ler o ledger
O saldo, o destinado e as parcelas restantes saem só de `debts`, `debt_balance_anchors` e `debt_payments`.
- **Alternativa:** derivar dos pagamentos da tabela do mês. Recusada: obrigaria o vínculo já agora e amarraria o módulo às projeções e à edição estrutural.
- **Custo aceito:** quem quiser o mês completo lança a parcela nos dois lugares.

**Vínculo futuro, registrado aqui:**
- acrescentar `debts.item_id` e `debt_payments.occurrence_id`, ambos nulos;
- um pagamento da ocorrência vinculada gera o `debt_payment`;
- a amortização que reduz o prazo precisa de uma operação nova no ledger: **cancelar as N últimas parcelas** de uma parcelada. Hoje "cancelar compra" cancela todas as futuras. Essa operação é o custo real do vínculo.

### 2. Saldo por âncora em vez de saldo calculado desde o início
O saldo real do banco inclui IOF, seguros, arredondamentos próprios e datas de cobrança, e nenhuma fórmula bate exatamente com ele. A âncora ("saldo em dd/mm") é a verdade; a estimativa vale só entre uma âncora e a próxima, e atualizar o saldo corrige o desvio.
- **Alternativa:** calcular tudo desde o contrato original. Recusada porque o erro se acumula.
- Pagamentos com data ≤ a da âncora são considerados incluídos nela. Essa regra é explícita, e a interface avisa no registro.

### 3. Passo mensal, juros no início do mês
`estimateBalance(anchor, ratePpm, payments, date)`:
- no mês da âncora, subtrai os pagamentos posteriores a ela;
- em cada mês seguinte, soma os juros (`Math.round(saldo * ppm / 1e6)`) e subtrai os pagamentos do mês até a data pedida;
- o piso é zero.

`saldo * ppm` é inteiro e menor que 2^53 para saldos até R$ 45 milhões com a taxa máxima (50% a.m.), então só a divisão é feita em ponto flutuante.
- **Alternativa:** juros pró-rata por dia. Recusada: complica sem ganho real, porque a âncora corrige.

### 4. Taxa em milionésimos (`monthly_rate_ppm integer`)
É consistente com "dinheiro em inteiro" e tem precisão suficiente (0,0001% a.m.). Faixa de 0 a 500000. A conversão a.a. → a.m. é `Math.round(((1 + a) ** (1/12) − 1) * 1e6)`, em `packages/shared` (`annualToMonthlyPpm`, com a inversa `monthlyPpmToAnnual` para exibir).
- **Alternativa:** `numeric(9,6)`. Recusada: o driver devolve string e o app não usa decimal em nenhum outro lugar.

### 5. Contrato com a forma de `items` e `contract_as_of`
`debts` guarda:
- `installment_cents` (Price, e Sem juros opcional);
- `remaining_installments` (`smallint`, Price/SAC);
- `due_day` (`smallint`);
- `min_payment_kind` (`fixed`/`percent`) e `min_payment_value` (centavos ou ppm, Rotativo);
- `contract_as_of` (`date`).

As parcelas restantes de hoje são `remaining_installments − count(pagamentos 'installment' com data > contract_as_of)`. `contract_as_of` é gravado:
- no cadastro (data da primeira âncora);
- na edição do contrato (hoje);
- em "Atualizar saldo" com contrato (data da âncora);
- na amortização extra (data do pagamento).

O SAC não guarda a amortização: ela é derivada (saldo ÷ parcelas restantes) no início de cada cálculo, porque guardar os dois valores daria duas fontes para o mesmo número.

### 6. Amortização extra grava o contrato recalculado que a pessoa confirmou
O cliente calcula o contrato sugerido com a regra pura (`recalcAfterExtra`) e mostra os campos editáveis. A API grava, numa transação, o pagamento e o contrato enviado. O servidor confere só os limites (parcela > 0, de 1 a 600 parcelas), não a fórmula, porque a pessoa pode corrigir com os números do banco.

Editar ou excluir o pagamento depois **não** desfaz o contrato.
- **Alternativa:** guardar o contrato anterior no pagamento para reverter. Recusada: com vários pagamentos e atualizações de saldo intercaladas, reverter fica ambíguo. Um aviso e "Editar dívida" resolvem.

### 7. Simulação pura, plano montado no servidor
`packages/shared/src/debts/`:
- `rates.ts`: conversão de taxa e juros do mês;
- `contract.ts`: PMT, nper, SAC e `recalcAfterExtra`;
- `balance.ts`: `estimateBalance` e parcelas restantes;
- `order.ts`: avalanche, bola de neve e manual, com os desempates;
- `simulate.ts`: `simulatePlan(debts, budgets, strategy, currentMonth, monthPaid)` → `{ perDebt: [{ payoffMonth | null, interestCents, timeline: number[] }], payoffMonth, totalInterestCents, warnings }`;
- `compare.ts`: as quatro estratégias;
- `whatIf.ts`: simulação de amortização de uma dívida.

`GET /debt-plan`:
- lê as dívidas ativas, as âncoras, os pagamentos e as vigências do orçamento;
- usa `clock.today`/`clock.currentMonth` (testável com o relógio do teste);
- calcula o saldo estimado e o que já foi pago no mês;
- roda a simulação e a comparação;
- devolve também o planejado × destinado.

O "e se" roda no navegador com o mesmo código, sem ida ao servidor.
- **Alternativa:** tudo no cliente. Recusada: o servidor precisa do saldo estimado para a lista e para os testes de integração, e uma só montagem evita divergência.

**Mês 0:** o saldo estimado de hoje já tem os juros do mês. Por isso o mês atual não reaplica juros e desconta do obrigatório os pagamentos já registrados no mês depois da âncora. A sobra do mês atual é `orçamento − destinado no mês − obrigatórios restantes`, com piso zero.

**Saída do 600º mês:** o laço para quando todos os saldos zeram ou em `currentMonth + 599`. A `timeline` traz até 600 pontos por dívida só para a estratégia escolhida; as outras devolvem apenas o resumo, para manter a resposta pequena.

### 8. Esquema
Todas as tabelas têm `wallet_id` com `on delete cascade`:

| Tabela | Colunas principais |
| --- | --- |
| `debts` | `id`, `wallet_id`, `name`, `category`, `creditor_name`, `creditor_person_id → people` (set null), `structure`, `monthly_rate_ppm`, contrato (Decisão 5), `accepts_extra`, `status` (`active`/`paid_off`), `paid_off_on`, `position`, `created_by`, `deleted_at`, `version`, `created_at`. Checks: credor exclusivo; Sem juros com taxa 0. Índice `(wallet_id) where deleted_at is null`. |
| `debt_balance_anchors` | `id`, `wallet_id`, `debt_id → debts` (cascade), `date`, `balance_cents`, `created_at`. Único `(debt_id, date)`: gravar na mesma data é upsert. |
| `debt_payments` | `id`, `wallet_id`, `debt_id`, `date`, `amount_cents`, `kind` (`installment`/`extra`), `extra_effect` (`reduce_term`/`reduce_installment`/nulo), `paid_by → users`, `version`, `created_at`. Índice `(wallet_id, date)` para o destinado. Fica pronta para receber `occurrence_id` nulo. |
| `debt_budgets` | `wallet_id`, `from_month char(7)`, `amount_cents`. PK `(wallet_id, from_month)`. |
| `debt_settings` | `wallet_id` (PK), `strategy` (padrão `avalanche`), `manual_order_set boolean`. |

A posição manual fica em `debts.position`:
- uma dívida nova recebe `max + 1`;
- ao escolher "Minha ordem" com `manual_order_set = false`, o servidor grava as posições pela avalanche e marca `true`;
- `PUT /debts/order` reescreve as posições na transação.

Migração: `npm run db:generate` → `0004_dividas.sql`.

### 9. API (sob `/api/wallets/:walletId`)

| Rota | O que faz |
| --- | --- |
| `GET /debts` | Ativas e quitadas, com saldo estimado, saldo inicial, pago até agora, parcelas restantes e âncora vigente. |
| `POST /debts` | Cria a dívida com a primeira âncora. |
| `GET /debts/:id` | Detalhe com âncoras e pagamentos. |
| `PUT /debts/:id` | Edita (com `version`). |
| `DELETE /debts/:id` | Exclusão lógica. |
| `POST /debts/:id/anchors`, `DELETE /debts/:id/anchors/:anchorId` | Atualizar saldo e remover âncora. |
| `POST /debts/:id/payments`, `PUT /debts/:id/payments/:paymentId`, `DELETE /debts/:id/payments/:paymentId` | Pagamentos. |
| `POST /debts/:id/pay-off` (`{ date, finalPayment?: boolean }`), `POST /debts/:id/reopen` | Quitar e reabrir. |
| `PUT /debts/order` (`{ ids }`) | Grava a ordem manual. |
| `GET /debt-settings`, `PUT /debt-settings` | Estratégia. |
| `GET /debt-budgets`, `PUT /debt-budgets/:month`, `DELETE /debt-budgets/:month` | Orçamento. |
| `GET /debt-plan` | Plano de quitação. |

Contratos zod em `packages/shared/src/schemas.ts` e tipos em `api-types.ts`.

Códigos novos de `AppError`:
- `last_anchor` (409);
- `debt_not_active` (409);
- `extra_not_allowed` (409).

Os demais são os que já existem: `validation`, `not_found`, `conflict`.

### 10. Interface

Componentes:
- `pages/DebtsPage.tsx`;
- `debts/` com `DebtFormModal`, `DebtPaymentModal`, `BalanceAnchorModal`, `WhatIfModal`, `BudgetModal`, `DebtTimeline` (SVG), `StrategyCompare` e `DebtList`;
- consultas em `lib/queries.ts` com chaves `['debts', walletId]`, `['debt-plan', walletId]` e `['debt-budgets', walletId]`, invalidadas juntas (`invalidateDebts`).

O módulo não invalida as chaves financeiras do mês, e vice-versa.

**Timeline sem paleta categórica:** o design system não tem cores de série. Por isso a timeline usa uma faixa por dívida, com rótulo direto e a área do saldo em `--primary-soft` contornada por `--primary`. Assim nenhuma cor precisa distinguir dívidas.

Acréscimos em `app.css` que devem voltar ao artifact do Design System, como diz o ADR-0009:
- `app-progress` (barra de progresso);
- `app-timeline`.

## Risks / Trade-offs

- **[Lançamento duplicado: a parcela vai na tabela do mês e na dívida]** → Aceito nesta entrega. A tela explica isso, e o vínculo B está desenhado (Decisão 1).
- **[A estimativa se afasta do saldo real (IOF, seguros, TR, juros diários)]** → A âncora corrige. A lista mostra "saldo informado em dd/mm", e a ajuda sugere atualizar com o app do banco.
- **[Contrato informado não fecha com saldo e taxa: parcela × n ≠ saldo]** → A simulação usa a parcela (Price) e quita quando o saldo zera. As parcelas restantes são informativas. Sem validação cruzada que impediria o cadastro.
- **[Payload grande com 600 meses × várias dívidas]** → A timeline só vai para a estratégia escolhida. O cliente agrupa por ano quando passa de 24 meses.
- **[Excluir amortização não reverte o contrato]** → Aviso explícito e edição manual (Decisão 6).
- **[Ponto flutuante em PMT e nper]** → Só nessas fórmulas, com o resultado arredondado ao centavo ou ao inteiro, e testes com valores conferidos.
- **[Alterações simultâneas em duas abas]** → `version` em `debts` e `debt_payments`, 409 `conflict`. A ordem manual é gravada inteira na transação.

## Migration Plan

1. Migração `0004` só cria tabelas: nenhuma alteração nas existentes e nenhum backfill.
2. Implantação normal. A API e o worker aplicam as migrações como hoje.
3. Rollback: reverter o código. As tabelas novas ficam sem uso e podem ser removidas por uma migração própria, se necessário.

## Open Questions

- Mostrar no mês (cards da Visão do mês) um atalho para o orçamento de dívidas? Fica para o vínculo.
- O `position` deve ser compartilhado entre membros da carteira familiar ou ser por pessoa? Hoje é por carteira, e a resposta pode ficar para quando a carteira familiar entrar.
