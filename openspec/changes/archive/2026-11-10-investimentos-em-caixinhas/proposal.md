## Why

O app mostra o que entra, o que sai e, desde a gestão de dívidas, quanto a pessoa deve. Falta o outro lado: **quanto ela tem guardado, quanto isso rende, quanto vai pagar de imposto e quando chega na meta**.

O balanço do mês também esconde uma decisão importante. O dinheiro que a pessoa resolveu guardar, ou usar para amortizar dívidas, aparece como "sobra". Ela vê um balanço positivo que, na prática, já tem destino.

## What Changes

- **Tela "Investimentos"** (`/investimentos`, item novo no menu principal), por carteira, no formato de **caixinhas**, como no Nubank.
  - Cada caixinha tem nome, ícone do design system, tipo, como rende, quando pode resgatar, imposto, meta opcional e "guardar por mês" opcional.
  - O módulo é **isolado da tabela do mês**, no padrão de Dívidas: não lê nem grava lançamentos, ocorrências, pagamentos nem faturas.
- **Tipos** (Caixinha/CDB/RDB, Tesouro, LCI/LCA, Poupança, Outro) que **sugerem** como rende, a liquidez e o imposto, enquanto a pessoa não muda esses campos.
- **Rendimento:**
  - Prefixado (a.m. ou a.a.);
  - % do CDI, com o **CDI anual estimado** como configuração da carteira, digitado pela pessoa;
  - Não rende.
  - A estimativa usa passo mensal composto.
- **Movimentações:** aporte e resgate, com data e valor.
  - O cadastro registra o **valor inicial** ("quanto você já tem e desde quando"), que entra no rendimento e no imposto, mas não no balanço de meses passados.
  - O resgate registra também os impostos retidos, já preenchidos com a estimativa.
- **Saldo informado (âncora)** com histórico, para alinhar a estimativa ao saldo do banco. É a mesma ideia das dívidas.
- **Imposto estimado:**
  - IR regressivo sobre o rendimento, pela idade de cada aporte (22,5% → 15%);
  - IOF regressivo nos primeiros 30 dias;
  - isenção para LCI, LCA e poupança;
  - resgates consomem os aportes mais antigos primeiro.
  - Por caixinha: saldo bruto, quanto rendeu, imposto se resgatar hoje e líquido hoje.
- **Projeção:** mês em que atinge a meta (ou aviso de que não chega até o mês-alvo), líquido estimado na data de resgate e rendimento mensal aproximado.
- **Trava de resgate:** "Só a partir de dd/mm/aaaa" recusa resgates antes da data. Também não dá para resgatar mais que o saldo estimado.
- **Encerrar e reabrir** uma caixinha. Encerrar resgata tudo. A seção "Encerradas" preserva o histórico.
- **Balanço do mês descontando o que tem destino:**
  - o resumo ganha "Guardar em caixinhas", "Resgatado das caixinhas" e "Amortizar dívidas";
  - o card "Balanço do mês" mostra a conta linha a linha, explicando por que o valor ficou menor;
  - previsto = o maior entre o planejado e o realizado no mês atual e nos futuros; só o realizado nos meses passados;
  - "Na conta até agora" também desconta os aportes e as amortizações extras feitos e soma os resgates.
  - **BREAKING** (para quem lê o número): o balanço previsto e o "Na conta até agora" mudam de valor quando há caixinhas ou orçamento de dívidas.
- **Dívidas no balanço, só a amortização extra:** as parcelas obrigatórias já são lançadas como despesa na tabela do mês. O balanço desconta só o que o orçamento de dívidas prevê **além** delas, mais as amortizações extras registradas. Sem contagem dupla.

## Capabilities

### New Capabilities
- `cadastro-de-caixinhas`: cadastro, edição, encerramento, reabertura e exclusão de caixinhas (tipo e sugestões, ícone, rendimento, liquidez, imposto, meta, guardar por mês). Inclui o valor inicial, a configuração do CDI da carteira e o saldo informado (âncora) com histórico.
- `movimentacoes-de-caixinhas`: aportes e resgates (registro, edição e exclusão), trava de resgate, limite pelo saldo estimado e impostos retidos no resgate.
- `rendimento-e-impostos`: saldo estimado, rendimento, IR regressivo por aporte, IOF, isenção, consumo dos aportes mais antigos, líquido hoje e projeção (meta, data de resgate, rendimento mensal).
- `tela-de-investimentos`: a tela `/investimentos` (cards de resumo, gráfico de evolução e projeção, caixinhas em cards, encerradas, configuração do CDI, formulários), o item no menu e as regras de layout e acessibilidade.

### Modified Capabilities
- `resumo-do-mes`:
  - o resumo traz guardar em caixinhas, resgatado das caixinhas e amortizar dívidas;
  - o balanço previsto e o realizado passam a descontar ou somar essas linhas;
  - o card "Balanço do mês" mostra a conta em linhas, com explicação.

## Impact

- **Banco:** tabelas novas com `wallet_id`:
  - caixinhas;
  - movimentações;
  - âncoras de saldo;
  - configuração de investimentos da carteira (CDI).
  - Migração `0005` gerada com `npm run db:generate`.
- **Compartilhado** (`packages/shared/src/investments/`):
  - rendimento;
  - tabelas de IR e IOF num arquivo só;
  - lotes por aporte;
  - saldo estimado;
  - projeção;
  - contratos zod e tipos da API.
  - Reaproveita `annualToMonthlyPpm`, `monthInterest` e `parsePercentToPpm` de `debts/rates.ts`.
  - `simulatePlan` de Dívidas passa a devolver também a **amortização extra planejada por mês**, um campo novo que não muda o resultado atual.
- **Servidor:**
  - `apps/server/src/domain/investments.ts`;
  - rotas sob `/api/wallets/:walletId/investments` e `/investment-settings`;
  - códigos `AppError` novos;
  - `domain/summary.ts` lê caixinhas e o plano de dívidas;
  - testes de integração novos (`investments.test.ts`) e os do resumo atualizados.
- **Interface:**
  - `pages/InvestmentsPage` e componentes em `apps/web/src/investments/`;
  - gráfico em SVG próprio, sem biblioteca nova;
  - rota e item no menu (`AppShell`);
  - `SummaryCards` com a conta do balanço;
  - ícones novos no padrão do design system para a lista de caixinhas.
- **Docs:**
  - ADR novo `0012-investimentos.md`;
  - ADR-0004 (resumo do mês), ADR-0009 (card do balanço, tela, ícones) e ADR-0011 (amortização extra no balanço);
  - `docs/decisions/README.md`;
  - `docs/PROGRESS.md`.
- **Dependência:** a change `gestao-de-dividas` ainda não foi arquivada. Esta change lê o módulo de Dívidas, mas não muda os requisitos dele.
