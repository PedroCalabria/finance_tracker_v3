## MODIFIED Requirements

### Requirement: Totais previstos no resumo do mês
O resumo do mês (`GET /summary`) SHALL trazer `income.forecastCents` e `expense.forecastCents`:
- `income.forecastCents` = recebido + a receber;
- `expense.forecastCents` = pago + a pagar.

**Gastos do mês = consumo pelo mês do gasto** (capability `mes-do-gasto`):
- **Fora do crédito:** as despesas do mês, com os pagamentos em "pago" e o restante em "a pagar". No mês atual, as atrasadas de meses anteriores entram em "a pagar" e em `lateCents`.
- **No crédito:** as compras e cobranças com mês do gasto no mês, gravadas ou previstas. A compra conta inteira em "pago" se a fatura dela está paga ou encerrada; senão, conta em "a pagar". Fatura atrasada não entra em `lateCents`, porque ela aparece no bloco de faturas.
- **Fora da conta:** os pagamentos de fatura (as compras já contaram no mês delas), o "Saldo restante da fatura" e as ocorrências canceladas. O "Ajuste da fatura" conta no mês da fatura.

`balance.forecastCents` SHALL ser `income.forecastCents − expense.forecastCents`. `balance.realizedCents` SHALL ser o caixa: recebido − (pagamentos das despesas do mês fora do crédito + pagamentos das faturas que vencem no mês).

#### Scenario: Mês com pago e a pagar
- **WHEN** o mês tem R$ 1.000,00 de despesas pagas, R$ 500,00 a pagar, R$ 3.000,00 recebidos e R$ 2.000,00 a receber, sem crédito
- **THEN** o resumo traz `expense.forecastCents` = 150000, `income.forecastCents` = 500000, `balance.forecastCents` = 350000 e `balance.realizedCents` = 200000

#### Scenario: Compras no cartão contam no mês da compra
- **WHEN** em novembro de 2026 a pessoa pagou R$ 1.000,00 em boleto e tem R$ 500,00 a pagar fora do crédito, comprou R$ 300,00 no cartão em 2026-11-10 (fatura de dez, aberta), pagou em novembro a fatura de nov de R$ 400,00 (compras de outubro), recebeu R$ 3.000,00 e tem R$ 2.000,00 a receber
- **THEN** o resumo de novembro traz gastos pagos 100000, a pagar 80000 e previsto 180000; `balance.forecastCents` = 320000; e `balance.realizedCents` = 160000 (3.000 − 1.000 − 400)

#### Scenario: Saldo transferido não conta duas vezes
- **WHEN** a fatura de nov foi paga em parte e o "Saldo restante da fatura nov" de R$ 150,00 entrou na fatura de dez
- **THEN** os R$ 150,00 não entram nos gastos de dezembro

### Requirement: Cards destacam o previsto
Os três cards do mês SHALL mostrar o previsto como valor principal e uma informação de realizado na linha de baixo:
- **Balanço do mês:** subtítulo "Entradas menos gastos do mês"; valor = balanço previsto; linha de baixo "Na conta até agora: R$ …" (`balance.realizedCents`, com "− " quando negativo).
- **Entradas do mês:** subtítulo "Previsto no mês"; valor = `income.forecastCents`; linha de baixo "R$ X recebido · R$ Y a receber".
- **Gastos do mês:** subtítulo "Previsto no mês"; valor = `expense.forecastCents`; linha de baixo "R$ X pago · R$ Y a pagar" e, quando houver, o selo "R$ … em atraso".

Os botões "Ver entradas" e "Ver despesas" SHALL continuar como estão.

#### Scenario: Leitura do mês
- **WHEN** a pessoa abre o mês do cenário "Compras no cartão contam no mês da compra"
- **THEN** o card de Balanço mostra R$ 3.200,00 em destaque e "Na conta até agora: R$ 1.600,00"; o de Entradas, R$ 5.000,00 e "R$ 3.000,00 recebido · R$ 2.000,00 a receber"; o de Gastos, R$ 1.800,00 e "R$ 1.000,00 pago · R$ 800,00 a pagar"

#### Scenario: Atraso no mês atual
- **WHEN** no mês atual há R$ 200,00 de despesas atrasadas de outubro fora do crédito
- **THEN** o valor previsto de Gastos inclui os R$ 200,00 e a linha de baixo mostra o selo "R$ 200,00 em atraso"
