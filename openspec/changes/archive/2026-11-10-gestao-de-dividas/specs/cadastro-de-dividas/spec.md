## ADDED Requirements

### Requirement: Cadastro de dívidas por carteira
A carteira SHALL ter um cadastro de dívidas em `/api/wallets/:walletId/debts`. Só membros da carteira SHALL ter acesso, como nas outras rotas financeiras.

O módulo é isolado da tabela do mês: criar, editar ou excluir uma dívida SHALL NOT criar, alterar ou excluir lançamentos, ocorrências, pagamentos ou faturas.

Cada dívida SHALL ter:
- **nome** (1 a 60 caracteres, sem espaços nas pontas);
- **categoria**;
- **credor** (opcional): texto livre (até 60 caracteres) ou uma Pessoa ativa da carteira, nunca os dois;
- **estrutura**;
- **taxa mensal**;
- **"aceita amortização extra"**;
- **situação**: `active` ou `paid_off`;
- **posição** na ordem manual;
- `version` para conflito de edição.

#### Scenario: Criar dívida
- **WHEN** a pessoa cadastra "Empréstimo Banco X", categoria Empréstimo pessoal, Price, 2,99% a.m., parcela de R$ 450,00, 18 parcelas restantes, dia 10, saldo de R$ 6.800,00 em 2026-11-05
- **THEN** a API responde 201 com a dívida ativa, taxa `29900`, e a primeira âncora de saldo em 2026-11-05 com 680000 centavos

#### Scenario: Outra carteira
- **WHEN** alguém que não é membro da carteira chama `/api/wallets/:walletId/debts`
- **THEN** a API recusa o acesso, como nas outras rotas financeiras

#### Scenario: Isolada da tabela do mês
- **WHEN** a pessoa cadastra uma dívida Price com 18 parcelas
- **THEN** nenhum lançamento ou ocorrência é criado e a tabela do mês não muda

#### Scenario: Credor como pessoa e texto ao mesmo tempo
- **WHEN** a requisição traz `creditorName` e `creditorPersonId`
- **THEN** a API responde 400 `validation`

### Requirement: Categorias e padrões
A categoria SHALL ser uma destas:
- `card_installment` ("Cartão: parcelamento de fatura");
- `overdraft` ("Cheque especial");
- `personal_loan` ("Empréstimo pessoal");
- `payroll_loan` ("Consignado");
- `vehicle_financing` ("Financiamento de veículo");
- `mortgage` ("Financiamento imobiliário");
- `person` ("Pessoa");
- `other` ("Outros").

A interface SHALL preencher padrões ao escolher a categoria, enquanto a pessoa não tiver mudado os campos à mão:
- `person` → estrutura Sem juros e o seletor de credor com as pessoas cadastradas;
- `mortgage` → SAC;
- `overdraft` → Rotativo;
- as demais → Price;
- "aceita amortização extra" vem marcado, exceto em `payroll_loan`.

A pessoa SHALL poder trocar qualquer padrão. Na categoria `person`, o credor SHALL ser uma Pessoa da carteira; sem ela, a API SHALL responder 400 `validation` no campo `creditorPersonId`.

#### Scenario: Padrão do consignado
- **WHEN** a pessoa escolhe a categoria Consignado
- **THEN** o formulário mostra Price e "Aceita amortização extra" desmarcado

#### Scenario: Pessoa sem credor
- **WHEN** a pessoa salva uma dívida da categoria Pessoa sem escolher a pessoa
- **THEN** a API responde 400 `validation` no campo `creditorPersonId`

### Requirement: Estrutura e contrato
A estrutura SHALL ser `price`, `sac`, `revolving` ou `interest_free`, e define os campos exigidos:
- **Price:** parcela atual (centavos > 0), parcelas restantes (1 a 600) e dia de vencimento (1 a 31).
- **SAC:** parcelas restantes (1 a 600) e dia de vencimento. A amortização mensal é saldo ÷ parcelas restantes, e a parcela do mês é amortização + juros.
- **Rotativo:** pagamento mínimo em valor fixo (centavos > 0) ou em percentual do saldo (de 0,01% a 100%), sem parcelas.
- **Sem juros:** taxa obrigatoriamente zero; parcela opcional (sem parcela, não há pagamento obrigatório).

Campos que não pertencem à estrutura escolhida SHALL ser gravados como nulos. Os campos do contrato (parcela, parcelas restantes, dia) SHALL ter a mesma forma dos campos equivalentes de `items` (centavos, `smallint`, dia de 1 a 31). Cada mudança no contrato SHALL gravar a data de referência do contrato (`contract_as_of`).

#### Scenario: Price sem parcela
- **WHEN** a pessoa salva uma dívida Price sem a parcela atual
- **THEN** a API responde 400 `validation` no campo `installmentCents`

#### Scenario: Sem juros com taxa
- **WHEN** a requisição traz estrutura `interest_free` e taxa 10000
- **THEN** a API responde 400 `validation` no campo `monthlyRatePpm`

#### Scenario: Troca de estrutura limpa campos
- **WHEN** uma dívida Price é editada para Rotativo com mínimo de 15%
- **THEN** a parcela e as parcelas restantes ficam nulas e o mínimo é gravado

### Requirement: Taxa mensal
A taxa SHALL ser mensal, com juros compostos, e gravada como inteiro em milionésimos da fração (2,99% a.m. = `29900`), de 0 a `500000` (50% a.m.). O formulário SHALL aceitar a taxa ao mês ou ao ano. A taxa ao ano SHALL ser convertida com (1 + a)^(1/12) − 1 e arredondada para o milionésimo mais próximo; a interface SHALL mostrar a taxa mensal resultante antes de salvar. O formulário SHALL mostrar a ajuda "Use o CET do contrato, se tiver" e, na categoria Financiamento imobiliário, também "Se o contrato tem TR ou IPCA, some uma estimativa do índice à taxa".

#### Scenario: Conversão de taxa anual
- **WHEN** a pessoa informa 12% a.a.
- **THEN** a taxa gravada é `9489` (0,9489% a.m.)

#### Scenario: Taxa acima do limite
- **WHEN** a requisição traz taxa `600000`
- **THEN** a API responde 400 `validation` no campo `monthlyRatePpm`

### Requirement: Aviso de rotativo no cartão
Quando a categoria é `card_installment` e a estrutura é Rotativo, o formulário SHALL mostrar o aviso: "O rotativo do cartão só pode durar até a fatura seguinte; depois o banco oferece um parcelamento. Se você já parcelou, cadastre como Price." O aviso SHALL NOT impedir o cadastro.

#### Scenario: Aviso aparece
- **WHEN** a pessoa escolhe Cartão e troca a estrutura para Rotativo
- **THEN** o aviso aparece abaixo da estrutura e o botão Salvar continua habilitado

### Requirement: Saldo por âncora com histórico
O saldo devedor SHALL ser informado como **âncora**: data (YYYY-MM-DD, não posterior a hoje) e saldo em centavos (≥ 0).
- O cadastro SHALL exigir a primeira âncora.
- "Atualizar saldo" (`POST /debts/:id/anchors`) SHALL gravar uma âncora nova. Em Price e SAC, a ação SHALL aceitar também as parcelas restantes e, no Price, a parcela atual; se vierem, atualizam o contrato com `contract_as_of` igual à data da âncora.
- Uma âncora na mesma data de uma existente SHALL substituí-la.
- Uma âncora SHALL poder ser excluída, desde que não seja a única da dívida (409 `last_anchor` com a mensagem "A dívida precisa ter pelo menos um saldo informado.").
- A âncora de data mais antiga é o **saldo inicial** e a de data mais recente é a **âncora vigente**.

#### Scenario: Atualizar saldo
- **WHEN** a dívida tem âncora de R$ 6.800,00 em 2026-11-05 e a pessoa informa R$ 6.420,00 em 2026-12-05
- **THEN** a âncora vigente passa a ser a de 2026-12-05 e o saldo inicial continua R$ 6.800,00

#### Scenario: Data futura
- **WHEN** a pessoa informa um saldo com data posterior a hoje
- **THEN** a API responde 400 `validation` no campo `date`

#### Scenario: Excluir a única âncora
- **WHEN** a pessoa tenta excluir a única âncora da dívida
- **THEN** a API responde 409 `last_anchor`

### Requirement: Saldo estimado
O saldo estimado de uma dívida em uma data SHALL ser calculado a partir da âncora vigente, mês a mês:
1. parte do saldo da âncora, no mês dela;
2. pagamentos com data **posterior** à da âncora e dentro do mês dela são subtraídos;
3. em cada mês seguinte até o mês da data pedida: primeiro os juros do mês (saldo × taxa, arredondados ao centavo, meio para cima) são somados, depois os pagamentos do mês até a data pedida são subtraídos;
4. o saldo nunca fica abaixo de zero.

Pagamentos com data igual ou anterior à da âncora SHALL ser considerados já incluídos no saldo informado. O cálculo SHALL ser uma regra pura em `packages/shared` e SHALL NOT ler lançamentos, ocorrências ou pagamentos da tabela do mês.

#### Scenario: Juros e pagamento no mês seguinte
- **WHEN** a âncora é R$ 1.000,00 em 2026-10-20, a taxa é 10% a.m. e há um pagamento de R$ 300,00 em 2026-11-10
- **THEN** o saldo estimado em 2026-11-15 é R$ 800,00 (1.000,00 + 100,00 − 300,00)

#### Scenario: Pagamento antes da âncora
- **WHEN** há um pagamento em 2026-11-01 e a âncora vigente é de 2026-11-05
- **THEN** o pagamento não reduz o saldo estimado

#### Scenario: Saldo não fica negativo
- **WHEN** os pagamentos depois da âncora somam mais que o saldo com juros
- **THEN** o saldo estimado é zero

### Requirement: Quitar, reabrir e excluir
- "Marcar como quitada" (`POST /debts/:id/pay-off` com a data, padrão hoje) SHALL mudar a situação para `paid_off`. A dívida sai da simulação, da lista principal e do resumo, e o histórico (âncoras e pagamentos) é preservado.
- Se o saldo estimado for maior que zero, a interface SHALL oferecer "Registrar o pagamento final de R$ X", que grava um pagamento do tipo parcela nesse valor e nessa data antes de quitar.
- "Reabrir" (`POST /debts/:id/reopen`) SHALL voltar a dívida para `active`, no fim da ordem manual.
- Excluir (`DELETE /debts/:id`) SHALL ser lógico (`deleted_at`): a dívida e seus pagamentos somem de todas as telas e deixam de contar no destinado.
- Uma edição com `version` desatualizada SHALL ser recusada com 409 `conflict`.

#### Scenario: Quitar com saldo zerado
- **WHEN** o saldo estimado é zero e a pessoa marca a dívida como quitada em 2027-03-10
- **THEN** a dívida vai para "Quitadas" com a data 2027-03-10 e não entra mais na simulação

#### Scenario: Quitar com pagamento final
- **WHEN** o saldo estimado é R$ 120,00 e a pessoa marca como quitada escolhendo "Registrar o pagamento final de R$ 120,00"
- **THEN** um pagamento de R$ 120,00 é gravado na data da quitação e a dívida fica quitada

#### Scenario: Excluir dívida
- **WHEN** a pessoa exclui uma dívida que tem pagamentos em novembro
- **THEN** a dívida some da tela e o destinado de novembro deixa de somar esses pagamentos
