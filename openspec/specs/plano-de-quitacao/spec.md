# plano-de-quitacao Specification

## Purpose
Estratégia de prioridade (avalanche, bola de neve, minha ordem), simulação mês a mês, previsão de quitação, timeline, comparação de estratégias e "E se eu amortizar?" (ADR-0011).
## Requirements
### Requirement: Estratégia de prioridade
A carteira SHALL ter uma estratégia de prioridade para as dívidas ativas. Ela é gravada com `PUT /api/wallets/:walletId/debt-settings` e o padrão é `avalanche`. As estratégias são:
- **`avalanche`:** maior taxa mensal primeiro. Empate: menor saldo estimado; depois, a dívida cadastrada antes.
- **`snowball`:** menor saldo estimado primeiro. Empate: maior taxa; depois, a dívida cadastrada antes.
- **`manual`** ("Minha ordem"): a posição gravada em cada dívida.

Comportamento da ordem manual:
- Ao escolher "Minha ordem" pela primeira vez, as posições SHALL ser inicializadas com a ordem da avalanche.
- A ordem é gravada com `PUT /debts/order` e a lista completa dos ids das dívidas ativas. Uma lista que não tenha exatamente as dívidas ativas SHALL ser recusada com 400 `validation`.
- Uma dívida nova ou reaberta SHALL entrar no fim da ordem manual. Se a estratégia é "Minha ordem", a interface SHALL avisar: "A dívida entrou no fim da sua ordem."

#### Scenario: Ordem da avalanche
- **WHEN** as dívidas ativas têm taxas de 12%, 3% e 0,9% a.m.
- **THEN** a ordem é 12%, 3%, 0,9%

#### Scenario: Ordem da bola de neve
- **WHEN** os saldos estimados são R$ 8.000,00, R$ 900,00 e R$ 3.000,00
- **THEN** a ordem é R$ 900,00, R$ 3.000,00, R$ 8.000,00

#### Scenario: Primeira vez em Minha ordem
- **WHEN** a estratégia é avalanche e a pessoa escolhe "Minha ordem" pela primeira vez
- **THEN** a lista aparece na ordem da avalanche e passa a respeitar as mudanças feitas com ↑↓

#### Scenario: Lista incompleta
- **WHEN** `PUT /debts/order` traz só 2 das 3 dívidas ativas
- **THEN** a API responde 400 `validation`

### Requirement: Pagamento obrigatório do mês
A simulação SHALL calcular o pagamento obrigatório de cada dívida no mês, nunca maior que o saldo depois dos juros:
- **Price:** a parcela, enquanto houver saldo.
- **SAC:** a amortização constante mais os juros do mês. A amortização é calculada no início da simulação: saldo estimado ÷ parcelas restantes, arredondado ao centavo. No último mês, o pagamento é o saldo que sobrar.
- **Rotativo:** o mínimo fixo ou o percentual do saldo depois dos juros, arredondado para cima ao centavo. Um saldo de até R$ 1,00 é pago inteiro, para o arredondamento não travar os últimos centavos (juros de 1 centavo e mínimo de 1 centavo para sempre).
- **Sem juros:** a parcela, se houver; sem parcela, zero.

#### Scenario: Última parcela menor
- **WHEN** uma dívida Price tem parcela de R$ 500,00 e saldo de R$ 120,00 depois dos juros
- **THEN** o obrigatório do mês é R$ 120,00

#### Scenario: Mínimo percentual
- **WHEN** um rotativo tem mínimo de 15% e saldo de R$ 2.000,00 depois dos juros
- **THEN** o obrigatório do mês é R$ 300,00

### Requirement: Simulação mês a mês
A simulação SHALL ser uma regra pura em `packages/shared/src/debts/`, com testes unitários, sobre as dívidas ativas com saldo estimado maior que zero. Os meses são do tipo `YYYY-MM`, sem `Date`.

**Mês atual (mês 0):** parte do saldo estimado de hoje, sem aplicar juros de novo, porque o saldo estimado já tem os juros do mês.
- Para cada dívida, o obrigatório que falta é o obrigatório do mês menos os pagamentos dela já registrados no mês depois da âncora vigente, com mínimo de zero.
- A sobra é o orçamento do mês menos o destinado no mês menos os obrigatórios que faltam.

**Cada mês seguinte:**
1. soma os juros do mês a cada saldo (saldo × taxa, arredondados ao centavo, meio para cima);
2. paga o obrigatório de cada dívida;
3. calcula a sobra: orçamento vigente no mês − obrigatórios;
4. se a sobra é positiva, destina a sobra às dívidas na ordem da estratégia, pulando as que não aceitam amortização extra. O que passar do saldo de uma vai para a próxima. A sobra que não tiver dívida para receber fica sem destino.

Uma dívida quitada deixa de ter obrigatório. Assim, a parcela dela aumenta a sobra dos meses seguintes (efeito bola de neve).

Na amortização extra simulada, Price e SAC reduzem o prazo: a parcela (Price) ou a amortização (SAC) fica igual.

A simulação SHALL parar quando todas as dívidas estiverem quitadas ou depois de 600 meses. O resultado traz:
- o mês de quitação de cada dívida (ou "não quita");
- o mês de quitação de todas;
- os juros futuros por dívida e o total;
- o saldo de cada dívida no fim de cada mês (timeline).

#### Scenario: Sobra e bola de neve
- **WHEN** o orçamento é R$ 1.000,00, não há pagamentos no mês atual, a dívida A (Sem juros, saldo R$ 600,00, parcela R$ 200,00) e a dívida B (Sem juros, saldo R$ 1.200,00, parcela R$ 300,00) aceitam amortização e a estratégia é bola de neve
- **THEN** no mês atual A recebe R$ 600,00 e é quitada, B recebe R$ 400,00 (R$ 300,00 de parcela e R$ 100,00 de sobra) e fica com R$ 800,00; no mês seguinte B recebe R$ 800,00 e é quitada, e sobram R$ 200,00 sem destino

#### Scenario: Pagamento já registrado no mês atual
- **WHEN** a parcela de R$ 450,00 do mês atual já foi registrada depois da âncora e o orçamento é R$ 1.000,00
- **THEN** a dívida não tem obrigatório restante no mês atual e a sobra do mês é R$ 550,00, menos os obrigatórios restantes das outras dívidas

#### Scenario: Dívida que não aceita amortização é pulada
- **WHEN** a primeira dívida da ordem é um consignado que não aceita amortização extra
- **THEN** a sobra vai para a segunda dívida da ordem e o consignado recebe só a parcela

#### Scenario: Não quita em 600 meses
- **WHEN** uma dívida tem obrigatório menor que os juros do mês e não recebe sobra
- **THEN** a simulação para em 600 meses e a dívida aparece como "não quita com este orçamento"

### Requirement: Avisos da simulação
O plano SHALL trazer avisos com código estável e texto pronto:
- **`budget_short`:** no mês atual, os obrigatórios somam mais que o orçamento. Texto: "O orçamento de R$ X não cobre as parcelas e mínimos (R$ Y)." A simulação paga os obrigatórios assim mesmo.
- **`not_decreasing`:** no primeiro mês simulado, o obrigatório de uma dívida é menor ou igual aos juros do mês. Texto: "O pagamento de <dívida> não cobre os juros: o saldo não diminui."
- **`no_budget`:** a carteira não tem orçamento vigente no mês atual.
- **`never_paid_off`:** há dívidas sem quitação em 600 meses.

#### Scenario: Orçamento insuficiente
- **WHEN** o orçamento é R$ 800,00 e as parcelas somam R$ 950,00
- **THEN** o plano traz `budget_short` com R$ 800,00 e R$ 950,00, e a simulação paga as parcelas

#### Scenario: Rotativo que não diminui
- **WHEN** um rotativo tem taxa de 14% a.m. e mínimo de 10% do saldo
- **THEN** o plano traz `not_decreasing` para essa dívida

### Requirement: Comparação de estratégias
O plano (`GET /api/wallets/:walletId/debt-plan`) SHALL trazer, para avalanche, bola de neve, minha ordem e **só o mínimo**: o mês de quitação de todas (ou "não quita") e os juros futuros totais.
- **Só o mínimo:** paga apenas os obrigatórios. Não há sobra destinada e a parcela de uma dívida quitada não passa para as outras.
- "Minha ordem" SHALL aparecer na comparação mesmo sem ter sido escolhida, usando as posições gravadas ou, se nunca foram gravadas, a ordem da avalanche.
- A timeline e as previsões por dívida SHALL ser as da estratégia escolhida.
- Quando a estratégia escolhida não é a de menor juros, a tela SHALL mostrar a diferença. Exemplo: "Sua ordem custa R$ X a mais em juros e quita N meses depois da avalanche."

#### Scenario: Diferença da ordem manual
- **WHEN** a estratégia é "Minha ordem" e os juros dela passam os da avalanche em R$ 1.240,00, com quitação 2 meses depois
- **THEN** a tela mostra "Sua ordem custa R$ 1.240,00 a mais em juros e quita 2 meses depois da avalanche."

#### Scenario: Só o mínimo não rola parcelas
- **WHEN** na estratégia "só o mínimo" a dívida A é quitada no mês 3
- **THEN** a parcela de A não é destinada a nenhuma outra dívida nos meses seguintes

### Requirement: Simular amortização
Para uma dívida ativa que aceita amortização extra, a tela SHALL oferecer "E se eu amortizar R$ X?". A comparação considera só essa dívida, pagando o contrato a partir do saldo estimado de hoje:
- **sem amortizar:** juros totais e parcelas restantes;
- **reduzindo prazo:** parcela, parcelas restantes, juros totais e economia (juros e meses a menos) em relação a não amortizar;
- **reduzindo parcela:** parcela nova, parcelas restantes, juros totais e economia em relação a não amortizar.

No Rotativo e no Sem juros, SHALL mostrar um só resultado (saldo menor, juros e meses até quitar pagando o obrigatório). O valor X SHALL ser de 1 centavo até o saldo estimado. O cálculo SHALL ser feito no navegador com a regra pura de `packages/shared` e SHALL NOT gravar nada. Um botão "Registrar esta amortização" SHALL abrir o registro de pagamento já preenchido com o valor e o efeito escolhidos.

#### Scenario: Comparar prazo e parcela
- **WHEN** a pessoa simula R$ 2.000,00 numa dívida Price de saldo R$ 5.000,00, taxa 2% a.m., parcela R$ 500,00
- **THEN** a tela mostra a economia de juros e os meses a menos de "reduzir prazo" e de "reduzir parcela", e "reduzir prazo" economiza mais juros

#### Scenario: Valor acima do saldo
- **WHEN** a pessoa digita um valor maior que o saldo estimado
- **THEN** o campo mostra "O valor passa do saldo de R$ X" e não calcula

