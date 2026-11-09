## ADDED Requirements

### Requirement: Totais previstos no resumo do mês
O resumo do mês (`GET /summary`) SHALL trazer, além dos campos atuais, `income.forecastCents` e `expense.forecastCents`:
- `income.forecastCents` = recebido + a receber;
- `expense.forecastCents` = pago + a pagar.

Os dois SHALL usar as mesmas regras de hoje: crédito entra pela fatura e, no mês atual, os atrasados entram em "a pagar"/"a receber". `balance.forecastCents` SHALL continuar sendo `income.forecastCents − expense.forecastCents`.

#### Scenario: Mês com pago e a pagar
- **WHEN** o mês tem R$ 1.000,00 de despesas pagas, R$ 500,00 a pagar, R$ 3.000,00 recebidos e R$ 2.000,00 a receber
- **THEN** o resumo traz `expense.forecastCents` = 150000, `income.forecastCents` = 500000 e `balance.forecastCents` = 350000

### Requirement: Cards destacam o previsto
Os três cards do mês SHALL mostrar o previsto como valor principal e o realizado na linha de baixo:
- **Balanço do mês:** subtítulo "Entradas menos gastos previstos"; valor = balanço previsto; linha de baixo "Realizado até agora: R$ …" (com "− " quando negativo).
- **Entradas do mês:** subtítulo "Previsto no mês"; valor = `income.forecastCents`; linha de baixo "R$ X recebido · R$ Y a receber".
- **Gastos do mês:** subtítulo "Previsto no mês"; valor = `expense.forecastCents`; linha de baixo "R$ X pago · R$ Y a pagar" e, quando houver, o selo "R$ … em atraso".

Os botões "Ver entradas" e "Ver despesas" SHALL continuar como estão.

#### Scenario: Leitura do mês
- **WHEN** a pessoa abre o mês do cenário anterior
- **THEN** o card de Balanço mostra R$ 3.500,00 em destaque e "Realizado até agora: R$ 2.000,00"; o de Entradas, R$ 5.000,00 e "R$ 3.000,00 recebido · R$ 2.000,00 a receber"; o de Gastos, R$ 1.500,00 e "R$ 1.000,00 pago · R$ 500,00 a pagar"

#### Scenario: Atraso no mês atual
- **WHEN** no mês atual há R$ 200,00 de despesas atrasadas de outubro
- **THEN** o valor previsto de Gastos inclui os R$ 200,00 e a linha de baixo mostra o selo "R$ 200,00 em atraso"
