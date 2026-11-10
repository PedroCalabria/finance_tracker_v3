# 0012 — Investimentos em caixinhas

**Status:** aceita · 10/11/2026 · código: `packages/shared/src/investments/`, `apps/server/src/domain/investments.ts`, `apps/web/src/pages/InvestmentsPage.tsx`, `apps/web/src/investments/` · change OpenSpec `investimentos-em-caixinhas`

## Contexto
O app mostra o que entra, o que sai e quanto a pessoa deve (ADR-0011). Não mostra quanto ela tem guardado, quanto rende, quanto vai pagar de imposto e quando chega na meta. O balanço do mês também tratava como "sobra" o dinheiro que já tinha destino: a caixinha do mês e a amortização extra das dívidas.

## Decisão

### Módulo isolado; o resumo do mês é o único leitor
- Tabelas próprias com `wallet_id`: `investments`, `investment_movements`, `investment_balance_anchors` e `investment_settings`. Rotas sob `/api/wallets/:walletId` (`/investments`, `/investments/overview`, `/investment-settings`), com autorização por membro.
- Nada no módulo lê ou grava lançamentos, ocorrências, pagamentos ou faturas. A importação de extrato continua ignorando as linhas "APLICACAO/RESGATE" (ADR-0010).
- `domain/summary.ts` lê o módulo (`monthInvestmentTotals`) e o de dívidas (`debtExtraForMonth`). A dependência tem mão única.
- Gravar o aporte como lançamento na tabela do mês arrastaria projeções, conciliação e edição estrutural (o mesmo motivo do ADR-0011). Mostrar uma linha própria no balanço também é mais claro.

### Modelo
- **Caixinha:**
  - nome;
  - ícone (chave de `INVESTMENT_ICONS`: os ícones de objetivo e os do app que servem, sem `trend`, que desenha uma queda; conferida no zod e, no web, contra `IconName` na compilação);
  - tipo: Caixinha/CDB/RDB, Tesouro, LCI/LCA, Poupança ou Outro;
  - rendimento: `yield_kind` `fixed` | `cdi` | `none`;
  - "resgate a partir de" (`redeemable_from`, nulo = a qualquer momento);
  - imposto: `regressive` | `exempt`;
  - meta (`goal_cents`, `goal_month`, este exige aquele);
  - "guardar por mês" (`monthly_plan_cents`);
  - `status` `active` | `closed`;
  - exclusão lógica.
- **O tipo só sugere** (no cliente, como a categoria das dívidas), enquanto a pessoa não muda esses campos:

  | Tipo | Rende como | Imposto |
  | --- | --- | --- |
  | Caixinha/CDB/RDB | 100% do CDI | regressivo |
  | Tesouro | 100% do CDI | regressivo |
  | LCI/LCA | 95% do CDI | isento |
  | Poupança | prefixado 0,5% a.m. | isento |
  | Outro | não rende | isento |

- **Rendimento:**
  - prefixado em milionésimos ao mês (`fixed_rate_ppm`, de 0 a 100000); o formulário aceita a.a. e converte com `annualToMonthlyPpm`;
  - % do CDI em centésimos de ponto (`cdi_share_bp`, 100% = 10000, de 1 a 30000);
  - o campo do outro tipo é gravado nulo (`normalizeInvestmentTerms` e `check` no banco).
- **CDI da carteira:** `investment_settings.cdi_annual_ppm` (14,90% a.a. = 149000), digitado pela pessoa, com `cdi_updated_on`.
  - Taxa efetiva = `round(annualToMonthlyPpm(CDI) × %CDI ÷ 10000)`.
  - Sem CDI, a caixinha de % do CDI não rende, e a visão geral avisa (`cdi_missing`).
  - O formulário pede o CDI ao escolher "% do CDI" quando ele falta.
  - Aplicar o % sobre a taxa mensal composta (e não sobre a diária, como os bancos) difere em centavos por ano. A âncora corrige.
- **Movimentações:**
  - `initial` | `deposit` | `withdrawal`, com `amount_cents > 0`.
  - O **valor inicial** ("quanto você já tem e desde quando") é uma movimentação, e não uma âncora, porque o imposto precisa da **idade** do dinheiro.
    - É obrigatório, único (índice parcial), editável e não excluível (409 `initial_movement_required`).
    - Nenhuma movimentação ou âncora pode ter data anterior a ele (409 `movement_before_initial`).
  - O **resgate** grava o bruto que sai da caixinha e os impostos retidos (`tax_cents`, de 0 até o valor; só no resgate). O modal preenche o imposto com a estimativa e deixa corrigir.
- **Saldo informado (âncora):** mesma semântica das dívidas. Âncora na mesma data substitui a anterior; o que tem data ≤ a da âncora já está nela. Aqui todas as âncoras podem ser excluídas, porque o ponto de partida é o valor inicial.

### Saldo estimado: uma caminhada (`walkInvestment`)
- Do primeiro evento até a data pedida, em ordem de data:
  - **virada de mês:** soma `monthInterest(saldo, taxa)`; o mês do primeiro evento não rende;
  - **aporte:** soma e cria um lote;
  - **resgate:** consome `round(resgate × principal ÷ saldo)` dos lotes mais antigos (FIFO) e subtrai o valor;
  - **âncora:** o saldo passa a ser o informado. Na mesma data, vem depois das movimentações. Os lotes não mudam: a diferença vira rendimento.
- O piso é zero. "Rendeu até hoje" = bruto − principal, e pode ser negativo.
- Diferente das dívidas, a caminhada começa no valor inicial e não na última âncora, porque os lotes precisam de todo o histórico.

### Imposto (`investments/taxes.ts`, tabelas num arquivo só)
- **IR regressivo** sobre o rendimento, pela idade de cada lote em dias corridos: até 180 → 22,5%; 181–360 → 20%; 361–720 → 17,5%; > 720 → 15%.
- **IOF regressivo** (96% no 1º dia a 3% no 29º; zero do 30º em diante) sobre o rendimento. O IR incide sobre o rendimento menos o IOF.
- **Distribuição do rendimento entre os lotes:** proporcional a principal × dias, em inteiros pelos maiores restos.
  - Proporcional só ao principal daria a um aporte de ontem o rendimento de anos, a 15% em vez de 22,5%.
  - Com âncora, o ajuste se espalha do mesmo jeito.
- Arredondamento meio para cima, por lote. Rendimento ≤ 0 ou caixinha isenta: zero.
- **Resgate parcial:** a mesma conta sobre a fatia dos lotes que o FIFO consumiria (`withdrawalTax`).
- **Legislação:** Lei 11.033/2004 (IR) e Decreto 6.306/2007 (IOF). A MP 1.303/2025 (alíquota única e IR sobre LCI/LCA) perdeu a validade. Conferido em 10/11/2026: a tabela e a isenção de LCI/LCA seguem vigentes; a proposta de 5% sobre LCI/LCA não foi aprovada. O IRPFM (Lei 15.270/2025, adicional para renda acima de R$ 600 mil/ano) fica fora. Mudou a lei? Troque `taxes.ts` e os testes.

### Projeção (`projectInvestment`)
- A partir do bruto de hoje, mês a mês: juros e depois o "guardar por mês", como um lote novo no dia 1.
- **Meta:** primeiro mês com **bruto** ≥ meta (o banco mostra o bruto).
  - Se não chega até o mês-alvo, o aviso traz o menor plano mensal que chega, por busca binária.
  - Sem chegar em 600 meses: "não chega".
- **Data de resgate:** bruto, imposto (idade dos lotes naquela data) e líquido.
- **Rende por mês:** `monthInterest(bruto, taxa)`.
- A visão geral soma 12 meses passados (todas as caixinhas não excluídas) e 24 de projeção (só as ativas).

### "Guardar por mês" sem vigências
- Vale o valor atual, no mês atual e nos futuros. Meses passados usam só o realizado, então mudar o plano não reescreve o passado.
- **Meta atingida não para o plano sozinha.** O card mostra "Meta atingida" e "Parar de guardar". Parar sozinho faria o balanço de meses futuros mudar por causa de uma projeção.

### Resumo do mês
- `Summary.investments`:
  - `depositedCents`: aportes do mês; o inicial fica fora porque já estava guardado;
  - `withdrawnCents`: valor − impostos dos resgates do mês;
  - `plannedCents`: null em meses passados; senão, a soma do plano das ativas;
  - `forecastCents` = realizado nos passados; `max(planejado, aportado)` no atual e nos futuros.
- `Summary.debtExtra`: **só a amortização extra** (ver ADR-0011). As parcelas e mínimos já estão nos gastos da tabela do mês.
- `balance.forecastCents` = entradas − gastos − `investments.forecast` + `investments.withdrawn` − `debtExtra.forecast`.
- `balance.realizedCents` = caixa − aportes + resgates − amortizações extras pagas.
- Caixinhas excluídas ficam fora; encerradas entram no realizado.

### Recusas
Ficam definidas no domínio, como em Dívidas.

| Código | Quando |
| --- | --- |
| 404 `investment_not_found` | caixinha inexistente ou de outra carteira |
| 409 `investment_not_active` | aporte ou resgate em caixinha encerrada |
| 409 `locked_until` | resgate ou encerramento antes de "resgate a partir de" ("Só pode resgatar a partir de dd/mm/aaaa.") |
| 409 `withdrawal_exceeds_balance` | resgate acima do saldo estimado na data, sem o próprio resgate na edição; a mensagem sugere atualizar o saldo |
| 409 `movement_before_initial` | movimentação ou âncora antes do valor inicial, ou valor inicial depois de outra movimentação |
| 409 `initial_movement_required` | excluir o valor inicial |

Datas no futuro são recusadas com `validation`.

### Encerrar e reabrir
- **Encerrar** grava, numa transação, um resgate do saldo estimado na data, com o imposto estimado (os dois editáveis no modal), e muda o status.
- **Reabrir** volta para ativa sem mexer nas movimentações.

## Consequências
- **Número do balanço muda** para quem tem caixinhas com plano, resgates ou orçamento de dívidas. O card mostra a conta inteira, com ⓘ. Sem nada disso, o card fica igual.
- **Estimativa × banco:** passo mensal, % do CDI sobre a taxa mensal, sem dias úteis. A âncora alinha; o resgate deixa corrigir o imposto.
- **Contagem dupla possível** se a pessoa lançar a amortização extra também na tabela do mês. O ⓘ e o ADR-0011 avisam.
- **Custo do resumo:** no mês atual e nos futuros, ele roda a simulação de dívidas (até 600 meses, poucas dívidas).
- **Fora desta entrega:**
  - ações, FII e cripto com cotação;
  - IPCA+;
  - busca automática do CDI;
  - come-cotas e taxa de custódia;
  - juros por dia útil;
  - vínculo das linhas de aplicação/resgate do extrato com movimentações;
  - vigências do plano;
  - lembretes por email.
