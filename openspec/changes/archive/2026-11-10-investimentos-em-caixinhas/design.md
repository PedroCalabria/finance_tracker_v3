## Context

A gestão de dívidas (ADR-0011, change `gestao-de-dividas`) criou um módulo isolado do ledger:
- tabelas próprias;
- matemática pura em `packages/shared/src/debts/`;
- saldo por âncora;
- simulação mês a mês;
- uma tela própria com timeline em SVG.

Investimentos têm a mesma forma: um saldo que muda por juros e movimentações, que o banco conhece melhor que o app, e que a pessoa quer projetar. Esta change segue o mesmo desenho e reaproveita o que já existe (`annualToMonthlyPpm`, `monthInterest`, `parsePercentToPpm`, `formatRatePpm`, `app-progress`, o estilo de `app-timeline`, `Segmented`).

A diferença é o **resumo do mês**. Hoje `monthSummary` (`apps/server/src/domain/summary.ts`) calcula `balance.forecastCents = entradas − gastos` e `balance.realizedCents` como caixa. Esta change faz o resumo **ler** dois módulos isolados, caixinhas e dívidas, sem que eles leiam ou gravem o ledger.

Restrições do projeto:
- centavos inteiros;
- datas e meses como string;
- regra pura com teste unitário;
- regra com banco com teste de integração;
- rotas por carteira com autorização por membro;
- `AppError` com código estável;
- só `ff-*` e tokens;
- migração do drizzle-kit;
- nada de `Promise.all` com `tx`.

## Goals / Non-Goals

**Goals:**
- Caixinhas simples de cadastrar e de ler, com sugestões pelo tipo.
- Saldo estimado confiável o bastante, corrigido por âncoras.
- Imposto estimado correto por aporte (IR regressivo, IOF, isenção) e líquido "se resgatar hoje".
- Projeção de meta e de data de resgate, com o aporte mensal planejado.
- Balanço do mês que desconta o que tem destino e mostra a conta, sem contar duas vezes as parcelas de dívidas.

**Non-Goals:**
- Renda variável com cotação (ações, FII, cripto); o tipo "Outro" cobre só com saldo informado.
- IPCA+, busca automática de CDI, come-cotas, taxa de custódia.
- Juros por dia útil: o passo é mensal.
- Vínculo das linhas de aplicação e resgate do extrato importado com movimentações.
- Vínculo de Dívidas com a tabela do mês.
- Lembretes por email.
- Histórico de vigências do "guardar por mês".

## Decisions

### 1. Módulo isolado; o resumo é o único leitor
- As tabelas de investimentos não referenciam `items`, `occurrences`, `payments` nem `invoices`, e o domínio delas não as lê.
- `domain/summary.ts` passa a ler:
  - os totais do mês das caixinhas;
  - a amortização extra (prevista e realizada) de `domain/debts.ts`.
- A dependência é de mão única: resumo → módulos.
- **Alternativa:** gravar o aporte como lançamento na tabela do mês, como o reembolso de terceiros. Recusada: arrasta projeções, conciliação e edição estrutural, o mesmo motivo do ADR-0011. Mostrar como linha própria no balanço também é mais claro que misturar com gastos.

### 2. Modelo de dados

**`investments`**
- `id`, `wallet_id`, `name`;
- `icon` (texto, chave da lista curada);
- `kind`: `savings_box` (Caixinha/CDB/RDB) | `treasury` | `lci_lca` | `poupanca` | `other`;
- `yield_kind`: `fixed` | `cdi` | `none`;
- `fixed_rate_ppm` (mensal, milionésimos da fração, de 0 a 100000, ou seja, até 10% a.m.) e `cdi_share_bp` (% do CDI em centésimos de ponto: 100% = 10000, de 1 a 30000). Os dois são normalizados: o campo do outro `yield_kind` é gravado nulo (`normalizeInvestmentTerms`, como `normalizeDebtTerms`);
- `redeemable_from` (`date` nula = a qualquer momento);
- `tax_mode`: `regressive` | `exempt`;
- `goal_cents` e `goal_month` (nulos; `goal_month` exige `goal_cents`);
- `monthly_plan_cents` (nulo ou > 0);
- `status`: `active` | `closed`, com `closed_on`;
- `created_at`, `deleted_at`, `version`.
- Índice por carteira onde `deleted_at is null`.

**`investment_movements`**
- `id`, `wallet_id`, `investment_id` (cascade), `date`;
- `kind`: `initial` | `deposit` | `withdrawal`;
- `amount_cents` > 0;
- `tax_cents` (só em `withdrawal`, ≥ 0 e ≤ amount; nulo nos demais, por `check`);
- `created_by`, `version`, `created_at`.
- Índice único parcial: um `initial` por caixinha.
- Índice `(wallet_id, date)` para o resumo.

**`investment_balance_anchors`**
- `id`, `investment_id` (cascade), `date`, `balance_cents` ≥ 0.
- Único `(investment_id, date)`: âncora na mesma data substitui a anterior.

**`investment_settings`**
- `wallet_id` (pk), `cdi_annual_ppm` (nulo; anual em milionésimos: 14,90% = 149000), `cdi_updated_on` (`date`).

Decisões dentro do modelo:
- **Valor inicial como `kind = 'initial'`**, e não como âncora: o imposto precisa da **idade** do dinheiro, e a âncora não tem lote.
  - O `initial` entra em rendimento, lotes e imposto, mas **não** entra no resumo do mês. É dinheiro que já estava guardado, e contá-lo descontaria do balanço de um mês passado algo que não saiu da conta naquele mês.
  - É obrigatório, editável e não excluível (409 `initial_movement_required`). Nenhuma movimentação pode ter data anterior a ele (409 `movement_before_initial`).
- **Resgate com `tax_cents`:** `amount_cents` é o que sai da caixinha (bruto). `tax_cents` é o retido, pré-preenchido com a estimativa e editável. No resumo, o resgatado é `amount − tax`, o que de fato chega na conta.
- **Sugestões pelo tipo só no cliente**, como a categoria das dívidas: o servidor grava o que recebe, depois de normalizar.

| Tipo | Rende como | Resgate | Imposto |
| --- | --- | --- | --- |
| Caixinha/CDB/RDB | % do CDI, 100% | a qualquer momento | regressivo |
| Tesouro | % do CDI, 100% | a qualquer momento | regressivo |
| LCI/LCA | % do CDI, 95% | a qualquer momento | isento |
| Poupança | prefixado, 0,5% a.m. | a qualquer momento | isento |
| Outro | não rende | a qualquer momento | isento |

- **Alternativa:** um campo único "taxa", com o CDI convertido na hora do cadastro. Recusada: quando o CDI muda, todas as caixinhas ficariam erradas.

### 3. Taxa efetiva mensal
- `fixed`: `fixed_rate_ppm`.
- `cdi`: `round(annualToMonthlyPpm(cdi_annual_ppm / 1e6) × cdi_share_bp / 10000)`.
- `none`: 0.
- **CDI ausente:** a taxa é 0 e o resumo da tela traz o aviso `cdi_missing` ("Informe o CDI para estimar o rendimento"). O formulário pede o CDI na hora quando a pessoa escolhe "% do CDI" e ele não está definido.
- Aplicar o % sobre a taxa mensal composta (e não sobre a diária, como os bancos) difere em centavos por ano. A âncora corrige.

### 4. Saldo estimado e lotes (`walkInvestment`, puro)
Uma só caminhada no tempo, do `initial` até a data pedida, produz o saldo e os lotes:
- **eventos:** movimentações e âncoras, ordenados por data. Na mesma data, a âncora vem **depois** das movimentações, porque a âncora já inclui as movimentações do dia (mesma regra das dívidas: o que tem data ≤ âncora está nela);
- **virada de mês:** o saldo recebe `monthInterest(saldo, taxa)`. Juros entram na virada, como em `estimateBalance`. O mês do primeiro evento não rende;
- **aporte (`initial` ou `deposit`):** saldo += valor; cria um lote `{ date, principal }`;
- **resgate:** principal consumido = `round(valor × principalTotal / saldo)`, tirado dos lotes mais antigos primeiro (FIFO); saldo −= valor;
- **âncora:** saldo = `balance_cents`. Os lotes não mudam: a diferença vira rendimento, positivo ou negativo;
- o piso do saldo é zero.

Saídas: `grossCents`, `principalCents` (soma dos lotes), `yieldCents = gross − principal` e os lotes com o principal restante.

- **Alternativa:** recalcular a partir da última âncora, como nas dívidas. Insuficiente aqui, porque os lotes precisam de todo o histórico de aportes e resgates.
- **Rendeu até hoje** = `yieldCents` (saldo − aportado líquido). Fica negativo se a âncora vier abaixo do principal; a interface mostra o sinal.

### 5. Imposto (`investments/taxes.ts`, puro, tabelas num arquivo só)
- **IR regressivo** pela idade do lote em dias corridos (`diffDays(lote.date, data)`): até 180 → 22,5%; 181–360 → 20%; 361–720 → 17,5%; > 720 → 15%.
- **IOF:** tabela regressiva de 30 posições sobre o rendimento (dia 1 = 96%, …, dia 29 = 3%, dia 30 em diante = 0%).
- **Distribuição do rendimento entre os lotes** (o ponto em aberto da proposta): proporcional a `principal × dias` de cada lote.
  - Sem âncora e com taxa constante, isso aproxima o rendimento real de cada lote.
  - Com âncora, espalha o ajuste de forma razoável.
  - **Alternativa:** proporcional só ao principal. Recusada: um aporte de ontem receberia o rendimento de anos, e o IR sairia a 22,5% em vez de 15%.
- **Por lote:** `iof = round(rend × iofRate)`; `ir = round((rend − iof) × irRate)`, porque o IR incide sobre o rendimento menos o IOF. Rendimento ≤ 0 não paga nada. Arredondamento meio para cima, centavo por lote.
- **`exempt`:** zero.
- **Imposto de um resgate de W** (prévia do modal e valor padrão de `tax_cents`): aplica a mesma conta à fatia dos lotes que o FIFO consumiria, com o rendimento da fatia = W − principal consumido.
- O cabeçalho do arquivo cita a regra vigente e lembra de conferi-la antes do merge (a MP 1303/2025, que unificava alíquotas e tributava LCI/LCA, perdeu a validade). O teste unitário fixa as faixas e a tabela do IOF.

### 6. Projeção (`projectInvestment`, puro)
- Parte do saldo estimado de hoje e dos lotes atuais. A cada mês seguinte: juros (`monthInterest`), depois o `monthly_plan_cents` como um lote novo com data no dia 1 do mês.
- **Meta:** primeiro mês com **saldo bruto** ≥ `goal_cents`. O bruto é o que o banco mostra na caixinha.
  - Se não atinge até `goal_month`, aviso "não chega até mmm/aaaa; guardando R$ X por mês chega".
  - Para calcular o X: o menor plano mensal que atinge a meta até `goal_month`, por busca binária em centavos sobre a mesma projeção.
  - Sem plano e sem rendimento que bastem: "Com o que está guardado hoje, não chega na meta".
- **Data de resgate:** projeta até o mês de `redeemable_from` e devolve o bruto, o imposto (lotes com idade naquela data) e o líquido.
- **Rende cerca de R$ X/mês** = `monthInterest(bruto de hoje, taxa)`.
- **Limite:** 600 meses (o mesmo de Dívidas). O gráfico usa 24.

### 7. "Guardar por mês" sem vigências
- Vale o valor atual, para o mês atual e os futuros. Meses passados usam só o realizado, então mudar o plano **não reescreve o passado** e dispensa vigências.
- **Meta atingida não para o plano automaticamente.** O card mostra "Meta atingida" com a ação "Parar de guardar" (zera o plano).
  - **Alternativa:** parar sozinho no mês projetado da meta. Recusada: o balanço de meses futuros mudaria por causa de uma projeção, o que é difícil de explicar.
- Caixinha encerrada deixa de planejar a partir do mês atual. Caixinha criada no mês M planeja de M em diante.

### 8. Resumo do mês
O tipo `Summary` ganha:

```ts
investments: { plannedCents: number | null; depositedCents: number; forecastCents: number; withdrawnCents: number };
debtExtra:   { plannedCents: number | null; paidCents: number; forecastCents: number };
```

Sendo `m` o mês pedido e `c` o mês atual:
- `investments.depositedCents`: soma dos `deposit` com data em `m`, de caixinhas não excluídas (ativas ou encerradas). O `initial` fica fora.
- `investments.withdrawnCents`: soma de `amount − tax` dos `withdrawal` com data em `m`.
- `investments.plannedCents`:
  - `null` se `m < c`;
  - senão, a soma de `monthly_plan_cents` das caixinhas **ativas** criadas até `m`.
- `investments.forecastCents`:
  - `m < c` → `depositedCents`;
  - senão → `max(plannedCents, depositedCents)`.
- `debtExtra.paidCents`: soma dos `debt_payments` com `kind = 'extra'` e data em `m`, de dívidas não excluídas.
- `debtExtra.plannedCents`:
  - `null` se `m < c`;
  - `m = c` → `paidCents` + a sobra que a simulação ainda aplica no mês 0;
  - `m > c` → a sobra aplicada na simulação no mês `m`.
  - "Sobra" é o orçamento menos as obrigatórias, em cascata e limitada aos saldos. Sem orçamento, a sobra é 0.
- `debtExtra.forecastCents`:
  - `m < c` → `paidCents`;
  - senão → `max(plannedCents, paidCents)`.
- `balance.forecastCents` = `income.forecast − expense.forecast − investments.forecast + investments.withdrawn − debtExtra.forecast`.
- `balance.realizedCents` = (caixa de hoje) `− investments.deposited + investments.withdrawn − debtExtra.paid`.

Por que a amortização extra vem da simulação, e não de `orçamento − parcelas`:
- a simulação já sabe quando uma dívida termina e quanto da sobra cabe no saldo;
- já descontou o que foi pago no mês atual;
- já trata a "bola de neve".
- Basta expor o que ela já calcula: `simulatePlan` devolve `extraByMonth: number[]` (índice 0 = mês atual), e `distribute` passa a devolver quanto aplicou. Os campos atuais não mudam, e os testes de Dívidas continuam valendo.
- Meses além do fim da simulação (dívidas quitadas) → 0.

Outras decisões do resumo:
- **Contagem dupla:** as parcelas obrigatórias continuam fora (já estão nos gastos da tabela do mês). O ADR-0011 e o ⓘ do card avisam para **não** lançar a amortização extra também na tabela do mês.
- **Custo:** o resumo do mês passa a rodar a simulação de dívidas, de até 600 meses e poucas dívidas, que é barata. Ela só roda para `m ≥ c`. Num mês passado, bastam as somas em SQL.
- As consultas novas rodam fora de transação, então podem entrar no `Promise.all` atual.

### 9. API (`/api/wallets/:walletId`)
- `GET/PUT /investment-settings`: CDI; o PUT grava `cdi_updated_on = hoje`.
- `GET /investments`: linhas com os valores calculados (bruto, principal, rendeu, imposto hoje, líquido hoje, rende/mês, meta, projeção curta, trava).
- `GET /investments/overview`, declarado antes de `/investments/:id`, como `/debts/order`:
  - totais;
  - "este mês" (planejado e aportado);
  - série de 12 meses passados (aportado e bruto no fim de cada mês) e 24 de projeção;
  - avisos (`cdi_missing`).
- `POST /investments` (cria com o `initial`), `GET/PUT/DELETE /investments/:id`, `POST /investments/:id/close`, `POST /investments/:id/reopen`.
- `POST /investments/:id/movements` e `PUT/DELETE /investments/:id/movements/:movementId`.
- `POST /investments/:id/anchors` e `DELETE /investments/:id/anchors/:anchorId`.

Recusas (`AppError`, mensagem pronta em português):

| Código | Status | Quando |
| --- | --- | --- |
| `investment_not_found` | 404 | caixinha não existe ou é de outra carteira |
| `investment_not_active` | 409 | movimentação em caixinha encerrada |
| `locked_until` | 409 | resgate ou encerramento antes de `redeemable_from` ("Só pode resgatar a partir de dd/mm/aaaa") |
| `withdrawal_exceeds_balance` | 409 | resgate maior que o saldo estimado na data ("Atualize o saldo se o banco mostra mais") |
| `initial_movement_required` | 409 | excluir o `initial` |
| `movement_before_initial` | 409 | movimentação com data anterior ao `initial` |
| `validation` | — | data no futuro (como `notAfterToday` em Dívidas) e campos inválidos, pelo zod |

- **Encerrar** grava, numa transação, um resgate do saldo estimado na data, com o imposto estimado (os dois editáveis no modal), e muda o status para `closed`.
- **Reabrir** volta para `active` sem mexer nas movimentações.
- **Excluir** é exclusão lógica: some da tela e do resumo.

### 10. Ícones
- `INVESTMENT_ICONS` em `packages/shared` é a lista de chaves aceitas pelo zod.
- No web, `INVESTMENT_ICONS satisfies readonly IconName[]` garante na compilação que todas existem em `Icon.tsx`.
- Do conjunto atual servem `wallet`, `bank`, `trend`, `calendar`, `card`, `tag` e `clock`.
- Faltam os de "objetivo". Entram, desenhados no padrão do design system (24 × 24, traço 1,75, `currentColor`): `piggy`, `shield`, `home`, `plane`, `car`, `gift`, `heart`, `book`, `star`.
- O ADR-0009 lista esses ícones entre os acréscimos que devem voltar ao artifact do Design System.
- **Alternativa:** emoji. Recusada por decisão da pessoa: foge dos tokens e muda de aparência entre sistemas.

### 11. Interface
- **Página** (`pages/InvestmentsPage.tsx` e `apps/web/src/investments/`), no padrão da `DebtsPage`:
  - cabeçalho com "+ Nova caixinha" e "CDI: 14,90% a.a. · atualizado em dd/mm" (botão que abre o modal do CDI);
  - quatro cards de resumo (`ff-summary-grid`);
  - "Evolução";
  - caixinhas em cards;
  - "Encerradas" recolhível.
- **Gráfico "Evolução"** (`InvestmentChart`, SVG próprio):
  - área do bruto (`--primary-soft`, contorno `--primary`);
  - linha do aportado (`--text-muted`);
  - linha vertical "hoje";
  - projeção com traço tracejado;
  - eixos e rótulos em HTML, como na timeline;
  - `Segmented` 6 meses | 1 ano | Projeção 2 anos;
  - `role="img"` com descrição, mais um resumo em texto ("Em 1 ano: aportou R$ X, rendeu R$ Y").
  - Duas séries bastam e dispensam a paleta de séries que o design system não tem.
- **Card da caixinha:**
  - ícone, nome, bruto e "100% do CDI" ou "1,1% a.m.";
  - `app-progress` da meta com "chega em mmm/aaaa", o aviso ou "Meta atingida";
  - "Resgate a partir de dd/mm/aaaa";
  - ações: Guardar, Resgatar, mais um menu (Atualizar saldo, Detalhes, Editar, Encerrar, Excluir).
- **Detalhes:** movimentações, âncoras e "Imposto se resgatar hoje" por faixa (tabela com faixa, rendimento, alíquota e imposto).
- **Formulário de cadastro, numa só tela em seções:**
  - nome e ícone;
  - tipo (aplica as sugestões);
  - quanto já tem e desde quando;
  - como rende;
  - "Mais opções" recolhível: meta, guardar por mês, trava de resgate, imposto.
  - Linguagem simples: "Quanto você já tem guardado aqui?", "Desde quando?", "Rende quanto?".
- **Modal Resgatar:**
  - valor;
  - prévia "Imposto estimado R$ X · você recebe cerca de R$ Y", calculada no cliente com as funções puras e os dados do detalhe;
  - campo "Impostos retidos" pré-preenchido.
- **Card "Balanço do mês"** (`SummaryCards`):
  - valor em destaque com o rótulo "livre no mês";
  - a conta em linhas (`Entradas`, `− Gastos`, `− Guardar em caixinhas`, `+ Resgatado das caixinhas`, `− Amortizar dívidas`), escondendo as linhas zeradas;
  - "Na conta até agora" fica embaixo.
  - O ⓘ é um **botão de abrir e fechar** (`aria-expanded`) que mostra a explicação abaixo da linha. Não há tooltip no design system, e passar o mouse não funciona no celular.
  - Cada explicação traz um link para a tela da caixinha ou das dívidas.
  - Textos:
    - caixinhas: "R$ 600 já guardados · R$ 400 a guardar neste mês";
    - dívidas: "Orçamento de dívidas menos as parcelas, que já estão nos gastos. Não lance a amortização também aqui na tabela".
  - Sem caixinhas e sem orçamento de dívidas, o card fica igual ao de hoje (subtítulo "Entradas menos gastos do mês").
- **Consultas:** `useInvestments`, `useInvestmentOverview` e `useInvestmentSettings`, com chaves por carteira. `invalidateInvestments` também invalida o resumo do mês, e `invalidateDebts` passa a invalidar o resumo.

## Risks / Trade-offs

- [Estimativa diferente do banco: passo mensal, % do CDI sobre a taxa mensal, dias úteis] → âncora com histórico; a lista mostra "saldo informado em dd/mm"; o ADR registra a aproximação.
- [Distribuição `principal × dias` não é a do banco quando há âncora] → é só estimativa; o resgate deixa a pessoa corrigir `tax_cents` com o valor do extrato.
- [Mudança de legislação do IR/IOF] → tabelas num arquivo só, com teste e comentário; conferir antes do merge.
- [Contagem dupla se a pessoa lançar a amortização extra também na tabela do mês] → aviso no ⓘ e no ADR-0011; o vínculo das dívidas com o ledger resolve depois.
- [Balanço dos meses futuros depende da simulação de dívidas] → determinística e testada; o ⓘ diz de onde vem.
- [O número do balanço muda para quem já usa o app] → o card mostra a conta inteira, e sem caixinhas nem orçamento de dívidas nada muda; registrado no PROGRESS.
- [Resumo mais lento por causa da simulação] → só roda para `m ≥ c`; dívidas são poucas. Se pesar, cachear por carteira por requisição.
- [Ícones novos fora do artifact do Design System] → listados no ADR-0009 como acréscimos a sincronizar.

## Migration Plan

- A migração `0005` só cria tabelas, então não precisa de backfill. Gerar com `npm run db:generate` e commitar o SQL.
- O deploy segue o fluxo normal: a migração roda na subida da API, protegida contra migrações simultâneas (já resolvido).
- **Rollback:** reverter o código. As tabelas novas podem ficar, porque nada antigo depende delas. O resumo volta ao cálculo anterior.

## Open Questions

- Confirmar, antes do merge, a tabela de IR e o IOF vigentes em 2026.
- A sugestão de 95% do CDI para LCI/LCA é só um valor inicial. Rever se a pessoa preferir 100%.
