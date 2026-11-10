## ADDED Requirements

### Requirement: Taxa efetiva mensal
A taxa mensal usada nas estimativas SHALL ser:
- prefixado: `fixed_rate_ppm`;
- % do CDI: `round(annualToMonthlyPpm(CDI anual) × cdi_share_bp / 10000)`;
- não rende: zero.

Sem CDI na carteira, as caixinhas com % do CDI MUST usar taxa zero, e o resumo da tela MUST trazer o aviso `cdi_missing` ("Informe o CDI para estimar o rendimento").

#### Scenario: 100% do CDI
- **WHEN** o CDI é 12,6825% a.a. e a caixinha rende 100% do CDI
- **THEN** a taxa mensal é 10000 ppm (1% a.m.)

#### Scenario: CDI ausente
- **WHEN** a carteira não tem CDI e há uma caixinha com % do CDI
- **THEN** a caixinha não rende na estimativa e a tela mostra o aviso para informar o CDI

### Requirement: Saldo estimado em passo mensal
O saldo bruto estimado SHALL sair de uma caminhada no tempo, do valor inicial até a data pedida, em ordem de data:
- **virada de mês:** soma os juros do mês (`monthInterest`, meio para cima). O mês do primeiro evento não rende;
- **aporte:** soma o valor;
- **resgate:** subtrai o valor;
- **âncora:** o saldo passa a ser o informado. Na mesma data, a âncora vem depois das movimentações.

O saldo MUST NOT ficar abaixo de zero.

"Rendeu até hoje" MUST ser o saldo bruto menos o principal restante, e pode ser negativo.

#### Scenario: Juros compostos mês a mês
- **WHEN** uma caixinha prefixada a 1% a.m. tem só o valor inicial de R$ 10.000,00 em 2026-03-10
- **THEN** o saldo estimado em 2026-11-10 é R$ 10.828,56 (8 viradas de mês) e "rendeu até hoje" é R$ 828,56

#### Scenario: Movimentação no dia da âncora
- **WHEN** há um aporte de R$ 100,00 e uma âncora de R$ 2.000,00, os dois em 2026-11-10
- **THEN** o saldo em 2026-11-10 é R$ 2.000,00, porque o aporte já está na âncora

### Requirement: Lotes por aporte e consumo dos mais antigos
Cada aporte, inclusive o valor inicial, SHALL formar um lote com data e principal.
- O resgate MUST consumir o principal `round(resgate × principal total ÷ saldo)`, tirado dos lotes mais antigos primeiro.
- A âncora MUST NOT mudar os lotes; a diferença vira rendimento.

#### Scenario: Resgate consome o lote mais antigo
- **WHEN** há os lotes A (R$ 1.000,00 em 2025-01-10) e B (R$ 1.000,00 em 2026-10-10), o saldo é R$ 2.200,00 e a pessoa resgata R$ 1.100,00
- **THEN** o principal consumido é R$ 1.000,00, todo do lote A, e fica só o lote B com R$ 1.000,00

### Requirement: Imposto se resgatar hoje
Para cada caixinha, o sistema SHALL calcular o imposto de um resgate total na data:
- **rendimento entre os lotes:** proporcional a principal × dias de cada lote;
- **IOF por lote:** tabela regressiva de 30 dias sobre o rendimento (dia 1 = 96%, …, dia 29 = 3%, dia 30 em diante = 0%);
- **IR por lote:** sobre o rendimento menos o IOF, pela idade em dias corridos: até 180 → 22,5%; 181 a 360 → 20%; 361 a 720 → 17,5%; acima de 720 → 15%;
- arredondamento meio para cima, por lote;
- rendimento menor ou igual a zero e caixinha isenta: zero.

As tabelas de IR e IOF MUST ficar num arquivo só em `packages/shared`, com teste.

A caixinha MUST mostrar o saldo bruto, quanto rendeu, o imposto se resgatar hoje e o líquido hoje.

#### Scenario: IR na faixa de 181 a 360 dias
- **WHEN** o único lote é de R$ 10.000,00 em 2026-03-10 e o saldo bruto em 2026-11-10 é R$ 10.828,56 (245 dias)
- **THEN** o IR é R$ 165,71 (20% de R$ 828,56), o IOF é zero e o líquido hoje é R$ 10.662,85

#### Scenario: IOF antes de 30 dias
- **WHEN** o único lote é de R$ 1.000,00 em 2026-11-01 e o saldo informado em 2026-11-10 é R$ 1.004,00 (9 dias)
- **THEN** o IOF é R$ 2,80 (70% de R$ 4,00), o IR é R$ 0,27 (22,5% de R$ 1,20) e o líquido hoje é R$ 1.000,93

#### Scenario: Rendimento por principal e tempo
- **WHEN** há o lote A de R$ 1.000,00 com 600 dias, o lote B de R$ 1.000,00 com 30 dias e rendimento total de R$ 63,00
- **THEN** R$ 60,00 do rendimento ficam no lote A (17,5%) e R$ 3,00 no lote B (22,5%)

#### Scenario: Caixinha isenta
- **WHEN** a caixinha é LCI/LCA, isenta, e rendeu R$ 500,00
- **THEN** o imposto é zero e o líquido é igual ao bruto

### Requirement: Projeção
O sistema SHALL projetar cada caixinha mês a mês a partir do saldo estimado de hoje. Em cada mês seguinte, soma os juros e depois o "guardar por mês", como um lote novo no dia 1. A projeção MUST trazer:
- **meta:** o primeiro mês em que o saldo bruto atinge a meta. Se não atinge até o mês-alvo, o aviso "Não chega até mmm/aaaa" com o menor valor mensal que chegaria ("guardando R$ X por mês, chega"). Se não atinge em 600 meses, "Com o que está guardado hoje, não chega na meta";
- **data de resgate:** o bruto, o imposto e o líquido estimados na data de "resgate a partir de";
- **rendimento mensal aproximado:** `monthInterest(saldo bruto de hoje, taxa)`.

#### Scenario: Quando chega na meta
- **WHEN** em 2026-11 uma caixinha que não rende tem R$ 10.000,00, guarda R$ 1.000,00 por mês e tem meta de R$ 15.000,00
- **THEN** a projeção diz "chega em abr/2027"

#### Scenario: Não chega até o mês-alvo
- **WHEN** a mesma caixinha tem a meta para fev/2027
- **THEN** a projeção avisa "Não chega até fev/2027" e sugere guardar R$ 1.666,67 por mês

#### Scenario: Líquido na data de resgate
- **WHEN** a caixinha só pode ser resgatada a partir de 2028-03-15
- **THEN** o card mostra o líquido estimado em 15/03/2028, com o imposto calculado pela idade dos lotes nessa data
