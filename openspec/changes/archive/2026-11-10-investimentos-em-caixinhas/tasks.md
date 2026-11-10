## 1. Regras puras (`packages/shared/src/investments/`)

- [x] 1.1 `types.ts`:
  - `INVESTMENT_KINDS` com rótulos;
  - `YIELD_KINDS`, `TAX_MODES`, `MOVEMENT_KINDS`;
  - `INVESTMENT_ICONS` (chaves curadas);
  - `KIND_DEFAULTS`, com as sugestões por tipo da spec (Caixinha/Tesouro 100% CDI regressivo, LCI/LCA 95% CDI isento, Poupança 0,5% a.m. isento, Outro não rende isento).
- [x] 1.2 `terms.ts`: `normalizeInvestmentTerms` (zera o campo do outro `yield_kind`) e `effectiveMonthlyPpm(terms, cdiAnnualPpm | null)`, reaproveitando `annualToMonthlyPpm`; CDI nulo → 0.
- [x] 1.3 `taxes.ts`:
  - tabelas `IR_BRACKETS` e `IOF_TABLE` (30 posições), com o comentário sobre a legislação vigente e o lembrete de conferir antes do merge;
  - `irRate(days)`, `iofRate(days)`;
  - `lotTaxes(lots, yieldCents, date, mode)`: rendimento proporcional a principal × dias, IOF antes do IR, meio para cima por lote;
  - `withdrawalTax(walk, amountCents, date, mode)`: a fatia dos lotes consumida pelo FIFO.
- [x] 1.4 `walk.ts`: `walkInvestment(movements, anchors, ratePpm, date)` → `{ grossCents, principalCents, yieldCents, lots }`:
  - juros na virada de mês com `monthInterest`;
  - âncora depois das movimentações do mesmo dia;
  - resgate consome `round(W × P / B)` dos lotes mais antigos;
  - piso zero.
- [x] 1.5 `project.ts`: `projectInvestment(walk, ratePpm, plan, goal, redeemableFrom, currentMonth, horizon)`:
  - série mensal (aportado e bruto);
  - mês da meta, ou aviso com o plano mínimo por busca binária;
  - "não chega" em 600 meses;
  - bruto, imposto e líquido na data de resgate;
  - rendimento mensal aproximado.
- [x] 1.6 `series.ts`: série dos 12 meses passados (aportado e bruto no fim de cada mês) a partir da caminhada, somada entre caixinhas.
- [x] 1.7 Testes unitários com os valores das specs:
  - 12,6825% a.a. → 10000 ppm;
  - R$ 10.000 a 1% a.m. de 2026-03-10 a 2026-11-10 = R$ 10.828,56;
  - IR 20% = R$ 165,71 e líquido R$ 10.662,85;
  - IOF no 9º dia (R$ 2,80 + R$ 0,27);
  - lotes 600 × 30 dias (R$ 60 / R$ 3);
  - FIFO com os lotes A e B;
  - âncora no mesmo dia do aporte;
  - isento;
  - rendimento negativo sem imposto;
  - meta em abr/2027 e plano mínimo de R$ 1.666,67;
  - virada de ano;
  - CDI ausente.
- [x] 1.8 Exportar em `packages/shared/src/index.ts`.

## 2. Contratos da API (`packages/shared`)

- [x] 2.1 `schemas.ts`:
  - `investmentCreateInput` (com o valor inicial e a data) e `investmentUpdateInput`, com limites de taxa e % do CDI, `goalMonth` exigindo `goalCents`, plano > 0, ícone em `INVESTMENT_ICONS` e taxa a.a. ou a.m.;
  - `investmentMovementInput` (`tax_cents` só no resgate, 0 ≤ imposto ≤ valor) e `investmentMovementUpdateInput`;
  - `investmentAnchorInput`, `investmentCloseInput` (data, valor e imposto opcionais) e `investmentSettingsInput`.
- [x] 2.2 `api-types.ts`:
  - `InvestmentRow`: bruto, principal, rendeu, imposto hoje, líquido hoje, rende/mês, taxa efetiva, meta (mês, aviso, plano sugerido), trava com o líquido na data, âncora vigente;
  - `InvestmentDetail`: movimentações, âncoras, imposto por faixa;
  - `InvestmentOverview`: totais, "este mês", série passada e projetada, avisos;
  - `InvestmentSettings`.
- [x] 2.3 `Summary` ganha `investments` e `debtExtra` (forma do design §8); testes de schema.

## 3. Dívidas: expor a amortização extra planejada

- [x] 3.1 `simulate.ts`: `distribute` devolve o valor aplicado; `SimResult` ganha `extraByMonth: number[]` (índice 0 = mês atual), sem mudar os campos atuais.
- [x] 3.2 Testes unitários de `extraByMonth`: orçamento 2.000 com obrigatórias 1.500 → 500; mês 0 com extra já pago; dívida quitada no meio (a sobra cai e depois zera); sem orçamento → zeros. Os testes de Dívidas existentes continuam passando.
- [x] 3.3 `domain/debts.ts`: `debtExtraForMonth(db, walletId, month, clock)` → `{ plannedCents | null, paidCents }`, com o pago = pagamentos `extra` do mês de dívidas não excluídas e o planejado pela simulação, só para `m ≥ c`.

## 4. Banco

- [x] 4.1 `schema.ts`: `investments`, `investment_movements`, `investment_balance_anchors` e `investment_settings`, com os `check`s do design (faixas, `tax_cents` só no resgate, `goal_month` exige `goal_cents`, plano > 0), o índice único parcial do `initial`, o único `(investment_id, date)` nas âncoras e o índice `(wallet_id, date)` nas movimentações.
- [x] 4.2 `npm run db:generate` (migração `0005`) e commitar o SQL e o snapshot.

## 5. Servidor (`apps/server/src/domain/investments.ts` e rotas)

- [x] 5.1 Carregar as caixinhas da carteira com movimentações, âncoras e configuração (consultas sequenciais dentro de `tx`). Montar `InvestmentRow`, `InvestmentDetail` e `InvestmentOverview` com as funções puras.
- [x] 5.2 Criar (caixinha + `initial` na mesma transação), editar (normalizar), excluir (lógica), encerrar (resgate do saldo estimado com o imposto estimado, ou os valores enviados, e status `closed`) e reabrir.
- [x] 5.3 Movimentações:
  - criar, editar e excluir;
  - data não futura;
  - `movement_before_initial`, `investment_not_active`, `locked_until`;
  - `withdrawal_exceeds_balance`, sem o resgate editado no saldo da comparação;
  - `initial_movement_required` ao excluir o inicial.
- [x] 5.4 Âncoras: criar (substitui na mesma data, data não futura) e excluir. Configuração: `GET/PUT /investment-settings`, com `cdi_updated_on` = hoje.
- [x] 5.5 `AppError`s novos em `http/errors.ts`, com as mensagens das specs.
- [x] 5.6 Rotas em `http/routes/wallet.ts` sob `/api/wallets/:walletId`, com `/investments/overview` antes de `/investments/:id`; autorização por membro.
- [x] 5.7 `domain/summary.ts`: somas do mês das caixinhas (aportes sem o `initial`, resgates − impostos, plano das ativas criadas até `m`) e `debtExtraForMonth`; novas fórmulas de `balance.forecastCents` e `balance.realizedCents`; `plannedCents` nulo em meses passados.

## 6. Testes de integração (`apps/server/test`)

- [x] 6.1 `investments.test.ts`:
  - cadastro com `initial` e normalização;
  - ícone inválido;
  - meta sem valor;
  - CDI e data de atualização;
  - âncora (substitui na mesma data, corrige o saldo);
  - aporte e resgate;
  - `movement_before_initial`, `investment_not_active`, `locked_until`, `withdrawal_exceeds_balance` (e o resgate após atualizar o saldo);
  - `initial_movement_required`;
  - imposto retido acima do valor;
  - encerrar e reabrir;
  - exclusão lógica;
  - outra carteira.
- [x] 6.2 Resumo: atualizar os cenários existentes (sem caixinhas e sem orçamento, os números não mudam) e acrescentar os da spec:
  - mês atual com caixinha e amortização planejadas (170000 / 100000);
  - aportou acima do planejado;
  - mês passado só realizado;
  - resgate com imposto;
  - valor inicial fora do resumo;
  - extra acima do planejado;
  - parcela de dívida não contada duas vezes.

## 7. Interface

- [x] 7.1 `Icon.tsx`: ícones novos no padrão do design system (`piggy`, `shield`, `home`, `plane`, `car`, `gift`, `heart`, `book`, `star`) e `INVESTMENT_ICONS satisfies readonly IconName[]`.
- [x] 7.2 `lib/queries.ts`:
  - `useInvestments`, `useInvestment`, `useInvestmentOverview`, `useInvestmentSettings`;
  - `invalidateInvestments` (inclui o resumo do mês);
  - `invalidateDebts` passa a invalidar o resumo do mês.
- [x] 7.3 Rota `/investimentos` em `App.tsx` e item "Investimentos" no menu do `AppShell`, junto de Dívidas.
- [x] 7.4 `pages/InvestmentsPage.tsx`:
  - cabeçalho com "+ Nova caixinha" e o CDI (abre o modal; "Informar CDI" sem valor);
  - quatro cards de resumo;
  - aviso `cdi_missing`;
  - estado vazio;
  - "Encerradas" recolhível com Reabrir.
- [x] 7.5 `investments/InvestmentChart.tsx`:
  - SVG próprio com a área do bruto e a linha do aportado, a marca "hoje" e a projeção tracejada;
  - `Segmented` 6 meses / 1 ano / Projeção 2 anos;
  - `role="img"` com descrição e resumo em texto;
  - eixos em HTML.
- [x] 7.6 `investments/InvestmentCard.tsx`:
  - ícone, nome, bruto e como rende;
  - `app-progress` da meta com "chega em", o aviso ou "Meta atingida" (+ "Parar de guardar");
  - trava com o líquido na data;
  - Guardar, Resgatar (oculto antes da trava) e menu de ações com rótulos acessíveis.
- [x] 7.7 `investments/InvestmentFormModal.tsx`:
  - seções e textos da spec;
  - sugestões pelo tipo sem sobrescrever o que a pessoa mudou;
  - seletor de ícone;
  - taxa a.m. ou a.a.;
  - "Mais opções" recolhível;
  - pede o CDI quando falta.
- [x] 7.8 `investments/MovementModal.tsx`:
  - Guardar e Resgatar;
  - prévia "Imposto estimado R$ X · você recebe cerca de R$ Y" com `withdrawalTax` no cliente;
  - "Impostos retidos" pré-preenchido e editável;
  - erros das recusas.
- [x] 7.9 `investments/InvestmentModals.tsx`:
  - Detalhes (movimentações com editar e excluir, âncoras, "Já considerado no saldo de dd/mm", imposto por faixa);
  - Atualizar saldo;
  - Encerrar (valor e imposto editáveis);
  - Excluir (`ConfirmDialog`);
  - CDI.
- [x] 7.10 `month/SummaryCards.tsx`:
  - Balanço com "livre no mês" e a conta em linhas (oculta as zeradas);
  - ⓘ de abrir e fechar com `aria-expanded`, a explicação e o link para Investimentos ou Dívidas;
  - "Na conta até agora";
  - sem destino no mês, igual a hoje.
- [x] 7.11 `styles/app.css`: classes de layout da tela, dos cards de caixinha, do gráfico e das linhas do balanço, só com tokens. Uma coluna em 390 px, sem rolagem horizontal.

## 8. Documentação

- [x] 8.1 `docs/decisions/0012-investimentos.md`: módulo isolado, modelo (inicial, resgate com imposto), taxa efetiva e CDI, caminhada e lotes, IR/IOF e a distribuição principal × dias, projeção, guardar por mês sem vigências, ícones, recusas.
- [x] 8.2 ADR-0004 (resumo do mês com caixinhas e amortização extra), ADR-0009 (card do balanço com ⓘ, tela de Investimentos, ícones novos entre os acréscimos a sincronizar com o artifact do Design System) e ADR-0011 (amortização extra no balanço, `extraByMonth`, aviso para não lançar a extra na tabela do mês).
- [x] 8.3 `docs/decisions/README.md` e `docs/PROGRESS.md` (etapa da fase 2, verificação, pendências e a mudança no número do balanço para quem já usa o app).

## 9. Verificação

- [x] 9.1 `npm run typecheck`, `npm test` (unitários e integração com Postgres) e `npm run build` sem erros.
- [x] 9.2 Conferir a tabela de IR e o IOF vigentes e registrar a fonte no comentário de `taxes.ts`.
- [x] 9.3 Roteiro no navegador em 1440 px (claro e escuro), 900 px e 390 px:
  - criar caixinhas de cada tipo;
  - guardar, resgatar com imposto, atualizar saldo;
  - trava;
  - encerrar e reabrir;
  - CDI;
  - gráfico nos três períodos;
  - card do Balanço com o ⓘ;
  - sem rolagem horizontal e sem erros no console.
