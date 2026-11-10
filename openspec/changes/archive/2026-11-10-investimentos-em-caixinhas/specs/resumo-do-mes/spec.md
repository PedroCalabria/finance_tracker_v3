## MODIFIED Requirements

### Requirement: Totais previstos no resumo do mês
O resumo do mês (`GET /summary`) SHALL trazer `income.forecastCents` e `expense.forecastCents`:
- `income.forecastCents` = recebido + a receber;
- `expense.forecastCents` = pago + a pagar.

**Gastos do mês = consumo pelo mês do gasto** (capability `mes-do-gasto`):
- **Fora do crédito:** as despesas do mês, com os pagamentos em "pago" e o restante em "a pagar". No mês atual, as atrasadas de meses anteriores entram em "a pagar" e em `lateCents`.
- **No crédito:** as compras e cobranças com mês do gasto no mês, gravadas ou previstas. A compra conta inteira em "pago" se a fatura dela está paga ou encerrada; senão, conta em "a pagar". Fatura atrasada não entra em `lateCents`, porque ela aparece no bloco de faturas.
- **Fora da conta:** os pagamentos de fatura (as compras já contaram no mês delas), o "Saldo restante da fatura" e as ocorrências canceladas. O "Ajuste da fatura" conta no mês da fatura.

O resumo SHALL trazer também o que tem destino no mês. Nas regras abaixo, `m` é o mês do resumo e `c` é o mês atual.

`investments` (caixinhas não excluídas, ativas ou encerradas):
- `depositedCents`: soma dos aportes com data em `m`. O valor inicial da caixinha fica fora;
- `withdrawnCents`: soma de (valor − impostos retidos) dos resgates com data em `m`;
- `plannedCents`: `null` se `m < c`; senão, a soma do "guardar por mês" das caixinhas **ativas** criadas até `m`;
- `forecastCents`: `depositedCents` se `m < c`; senão, `max(plannedCents, depositedCents)`.

`debtExtra` (dívidas não excluídas):
- `paidCents`: soma dos pagamentos de dívida do tipo amortização extra com data em `m`;
- `plannedCents`:
  - `null` se `m < c`;
  - em `m = c`, `paidCents` mais a sobra que o plano de quitação ainda aplica no mês atual;
  - em `m > c`, a sobra aplicada pelo plano no mês `m`;
  - a sobra é o orçamento de dívidas menos as parcelas e mínimos obrigatórios, limitada aos saldos; sem orçamento, zero;
- `forecastCents`: `paidCents` se `m < c`; senão, `max(plannedCents, paidCents)`.

As parcelas e mínimos obrigatórios das dívidas MUST NOT entrar em `debtExtra`: eles já estão nos gastos da tabela do mês.

Fórmulas do balanço:
- `balance.forecastCents` SHALL ser `income.forecastCents − expense.forecastCents − investments.forecastCents + investments.withdrawnCents − debtExtra.forecastCents`.
- `balance.realizedCents` SHALL ser o caixa: recebido − (pagamentos das despesas do mês fora do crédito + pagamentos das faturas que vencem no mês) − `investments.depositedCents` + `investments.withdrawnCents` − `debtExtra.paidCents`.

#### Scenario: Mês com pago e a pagar
- **WHEN** o mês tem R$ 1.000,00 de despesas pagas, R$ 500,00 a pagar, R$ 3.000,00 recebidos e R$ 2.000,00 a receber, sem crédito, sem caixinhas e sem orçamento de dívidas
- **THEN** o resumo traz `expense.forecastCents` = 150000, `income.forecastCents` = 500000, `balance.forecastCents` = 350000 e `balance.realizedCents` = 200000

#### Scenario: Compras no cartão contam no mês da compra
- **WHEN** em novembro de 2026 a pessoa pagou R$ 1.000,00 em boleto e tem R$ 500,00 a pagar fora do crédito, comprou R$ 300,00 no cartão em 2026-11-10 (fatura de dez, aberta), pagou em novembro a fatura de nov de R$ 400,00 (compras de outubro), recebeu R$ 3.000,00 e tem R$ 2.000,00 a receber, sem caixinhas e sem orçamento de dívidas
- **THEN** o resumo de novembro traz gastos pagos 100000, a pagar 80000 e previsto 180000; `balance.forecastCents` = 320000; e `balance.realizedCents` = 160000 (3.000 − 1.000 − 400)

#### Scenario: Saldo transferido não conta duas vezes
- **WHEN** a fatura de nov foi paga em parte e o "Saldo restante da fatura nov" de R$ 150,00 entrou na fatura de dez
- **THEN** os R$ 150,00 não entram nos gastos de dezembro

#### Scenario: Mês atual com caixinha e amortização planejadas
- **WHEN** no mês atual (2026-11) do cenário "Compras no cartão contam no mês da compra" há uma caixinha ativa com guardar por mês de R$ 1.000,00 e R$ 600,00 aportados em novembro, e as dívidas têm orçamento de R$ 2.000,00, R$ 1.500,00 de parcelas obrigatórias, saldo suficiente e nenhuma amortização extra no mês
- **THEN** o resumo traz `investments` = { planejado 100000, aportado 60000, previsto 100000 }, `debtExtra` = { planejado 50000, pago 0, previsto 50000 }, `balance.forecastCents` = 170000 (320000 − 100000 − 50000) e `balance.realizedCents` = 100000 (160000 − 60000)

#### Scenario: Aportou mais que o planejado
- **WHEN** no mês atual o guardar por mês somado é R$ 1.000,00 e a pessoa já aportou R$ 1.500,00
- **THEN** `investments.forecastCents` = 150000

#### Scenario: Mês passado conta só o realizado
- **WHEN** em outubro de 2026, já passado, a caixinha tinha guardar por mês de R$ 1.000,00 e nada foi aportado
- **THEN** o resumo de outubro traz `investments.plannedCents` = null e `investments.forecastCents` = 0

#### Scenario: Resgate volta para o balanço
- **WHEN** em novembro a pessoa resgatou R$ 2.000,00 de uma caixinha com R$ 50,00 de impostos retidos
- **THEN** `investments.withdrawnCents` = 195000, e esse valor soma em `balance.forecastCents` e em `balance.realizedCents`

#### Scenario: Valor inicial não conta no mês
- **WHEN** a pessoa cria em novembro uma caixinha com R$ 10.000,00 guardados desde 2026-03-10
- **THEN** nem o resumo de março nem o de novembro mudam por causa desse valor

#### Scenario: Amortização extra acima do planejado
- **WHEN** no mês atual o plano de quitação prevê R$ 500,00 de sobra e a pessoa já registrou R$ 800,00 de amortização extra
- **THEN** `debtExtra.paidCents` = 80000, `debtExtra.forecastCents` = 80000 e o caixa desconta os R$ 800,00

#### Scenario: Parcelas de dívidas não contam duas vezes
- **WHEN** a parcela de R$ 800,00 do empréstimo está lançada como despesa na tabela do mês e registrada como pagamento de parcela na dívida
- **THEN** ela entra só nos gastos do mês, e não em `debtExtra`

### Requirement: Cards destacam o previsto
Os três cards do mês SHALL mostrar o previsto como valor principal e uma informação de realizado na linha de baixo:
- **Balanço do mês:**
  - valor = balanço previsto, com "− " quando negativo;
  - sem caixinhas, resgates e amortização extra no mês: subtítulo "Entradas menos gastos do mês";
  - com qualquer um deles: rótulo "livre no mês" e, abaixo do valor, a conta em linhas: "Entradas", "− Gastos", "− Guardar em caixinhas", "+ Resgatado das caixinhas" e "− Amortizar dívidas". Linhas zeradas ficam ocultas;
  - linha de baixo: "Na conta até agora: R$ …" (`balance.realizedCents`, com "− " quando negativo).
- **Entradas do mês:** subtítulo "Previsto no mês"; valor = `income.forecastCents`; linha de baixo "R$ X recebido · R$ Y a receber".
- **Gastos do mês:** subtítulo "Previsto no mês"; valor = `expense.forecastCents`; linha de baixo "R$ X pago · R$ Y a pagar" e, quando houver, o selo "R$ … em atraso".

As linhas "Guardar em caixinhas" e "Amortizar dívidas" SHALL ter um botão ⓘ de abrir e fechar (`aria-expanded`). Ele mostra, abaixo da linha, de onde vem o valor e um link para a tela correspondente:
- **caixinhas:** "R$ X já guardados · R$ Y a guardar neste mês" no mês atual; "Guardado neste mês" nos passados;
- **dívidas:** "Orçamento de dívidas menos as parcelas, que já estão nos gastos. Não lance a amortização também na tabela do mês."

Os botões "Ver entradas" e "Ver despesas" SHALL continuar como estão.

#### Scenario: Leitura do mês
- **WHEN** a pessoa abre o mês do cenário "Compras no cartão contam no mês da compra", sem caixinhas e sem orçamento de dívidas
- **THEN** o card de Balanço mostra R$ 3.200,00 em destaque, o subtítulo "Entradas menos gastos do mês" e "Na conta até agora: R$ 1.600,00"; o de Entradas, R$ 5.000,00 e "R$ 3.000,00 recebido · R$ 2.000,00 a receber"; o de Gastos, R$ 1.800,00 e "R$ 1.000,00 pago · R$ 800,00 a pagar"

#### Scenario: Atraso no mês atual
- **WHEN** no mês atual há R$ 200,00 de despesas atrasadas de outubro fora do crédito
- **THEN** o valor previsto de Gastos inclui os R$ 200,00 e a linha de baixo mostra o selo "R$ 200,00 em atraso"

#### Scenario: Balanço com destino
- **WHEN** a pessoa abre o mês do cenário "Mês atual com caixinha e amortização planejadas"
- **THEN** o card de Balanço mostra R$ 1.700,00 "livre no mês", as linhas "Entradas R$ 5.000,00", "− Gastos R$ 1.800,00", "− Guardar em caixinhas R$ 1.000,00" e "− Amortizar dívidas R$ 500,00", sem a linha de resgate, e "Na conta até agora: R$ 1.000,00"

#### Scenario: Explicação da linha
- **WHEN** a pessoa toca no ⓘ de "Guardar em caixinhas" nesse mês
- **THEN** abaixo da linha aparece "R$ 600,00 já guardados · R$ 400,00 a guardar neste mês" com o link "Ver investimentos", e o botão fica com `aria-expanded="true"`
