## ADDED Requirements

### Requirement: Orçamento mensal com histórico
A carteira SHALL ter um orçamento mensal para dívidas: o **total** que a pessoa consegue destinar às dívidas por mês, já incluindo parcelas e pagamentos mínimos. O orçamento SHALL ser gravado como uma lista de vigências "a partir de AAAA-MM: valor em centavos (≥ 0)", com no máximo uma vigência por mês.

O orçamento de um mês SHALL ser o da vigência de mês mais recente que seja menor ou igual a ele. Sem vigência anterior, o mês fica sem orçamento.

As operações são:
- `GET /api/wallets/:walletId/debt-budgets`: lista as vigências.
- `PUT /api/wallets/:walletId/debt-budgets/:month`: grava ou substitui a vigência do mês.
- `DELETE /api/wallets/:walletId/debt-budgets/:month`: remove a vigência.

Gravar uma vigência SHALL valer do mês escolhido até a próxima vigência gravada. Os meses anteriores SHALL continuar com o orçamento que tinham.

#### Scenario: Mudar o orçamento daqui em diante
- **WHEN** existe "a partir de 2026-09: R$ 2.000,00" e a pessoa grava "a partir de 2026-11: R$ 2.500,00"
- **THEN** setembro e outubro continuam com R$ 2.000,00, e novembro e os meses seguintes passam a R$ 2.500,00

#### Scenario: Vigência no meio
- **WHEN** existem vigências em 2026-09 (R$ 2.000,00) e 2027-01 (R$ 3.000,00) e a pessoa grava 2026-11 (R$ 2.500,00)
- **THEN** novembro e dezembro ficam com R$ 2.500,00 e janeiro em diante continua R$ 3.000,00

#### Scenario: Mês sem orçamento
- **WHEN** a primeira vigência é de 2026-11
- **THEN** outubro aparece sem orçamento planejado

#### Scenario: Mês inválido
- **WHEN** a requisição usa o mês `2026-13`
- **THEN** a API responde 400 `validation`

### Requirement: Planejado × destinado por mês
Para cada mês, a tela SHALL comparar:
- **Planejado:** o orçamento vigente no mês.
- **Destinado:** a soma dos pagamentos de dívidas registrados com data no mês, em dívidas não excluídas (ativas ou quitadas), de todos os tipos.
- **Diferença:** destinado − planejado.

O destinado SHALL ser calculado, nunca digitado. A lista SHALL ir do primeiro mês com vigência ou pagamento até o mês atual, mostrando os 12 mais recentes, com o mês atual marcado como "em andamento". A API SHALL entregar essa lista no plano de quitação (`GET /debt-plan`).

#### Scenario: Mês abaixo do planejado
- **WHEN** o orçamento de outubro é R$ 2.000,00 e os pagamentos de outubro somam R$ 1.650,00
- **THEN** outubro mostra planejado R$ 2.000,00, destinado R$ 1.650,00 e diferença −R$ 350,00

#### Scenario: Pagamento de dívida quitada conta
- **WHEN** uma dívida quitada em novembro teve um pagamento de R$ 300,00 em novembro
- **THEN** o destinado de novembro inclui os R$ 300,00

#### Scenario: Sem orçamento
- **WHEN** um mês tem pagamentos mas nenhum orçamento vigente
- **THEN** o mês mostra o destinado e "sem orçamento" no planejado, sem diferença

### Requirement: Orçamento na simulação
A simulação do plano de quitação SHALL usar o orçamento vigente em cada mês simulado, o que inclui as vigências futuras já gravadas. Se o mês atual não tiver orçamento, a simulação SHALL usar só os pagamentos obrigatórios (equivalente a "só o mínimo"), e a tela SHALL mostrar "Defina quanto você consegue destinar às dívidas por mês" com o atalho para o orçamento.

#### Scenario: Vigência futura
- **WHEN** existe "a partir de 2027-03: R$ 3.000,00" e o orçamento atual é R$ 2.000,00
- **THEN** a simulação usa R$ 2.000,00 até fevereiro de 2027 e R$ 3.000,00 a partir de março

#### Scenario: Sem orçamento definido
- **WHEN** a carteira não tem nenhuma vigência
- **THEN** o plano simula só os obrigatórios e mostra o convite para definir o orçamento
