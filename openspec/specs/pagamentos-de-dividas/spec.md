# pagamentos-de-dividas Specification

## Purpose
Pagamentos de dívidas (parcela e amortização extra), com edição e exclusão, e o recálculo do contrato ao reduzir prazo ou parcela (ADR-0011).
## Requirements
### Requirement: Registrar pagamento da dívida
A pessoa SHALL poder registrar pagamentos de uma dívida ativa em `POST /api/wallets/:walletId/debts/:id/payments`. Cada pagamento tem:
- **data** (YYYY-MM-DD, não posterior a hoje);
- **valor** (centavos > 0);
- **tipo**: `installment` (parcela ou mínimo) ou `extra` (amortização extra);
- quem registrou (`paid_by`).

Os pagamentos SHALL ficar numa tabela própria (`debt_payments`), separada dos pagamentos da tabela do mês, e registrar um pagamento SHALL NOT criar lançamento, ocorrência ou pagamento na tabela do mês. Em uma dívida quitada ou excluída, o registro SHALL ser recusado com 409 `debt_not_active` e a mensagem "Esta dívida não está ativa.".

#### Scenario: Registrar parcela
- **WHEN** a pessoa registra uma parcela de R$ 450,00 em 2026-11-10
- **THEN** a API responde 201, o saldo estimado diminui e nenhum lançamento é criado na tabela do mês

#### Scenario: Pagamento antes da âncora
- **WHEN** a pessoa registra um pagamento com data anterior ou igual à da âncora vigente
- **THEN** o pagamento é gravado, conta em "pago até agora" e no destinado do mês dele, não reduz o saldo estimado, e a interface mostra "Já considerado no saldo de dd/mm/aaaa"

#### Scenario: Dívida quitada
- **WHEN** a pessoa tenta registrar um pagamento numa dívida quitada
- **THEN** a API responde 409 `debt_not_active`

### Requirement: Amortização extra recalcula o contrato
O tipo `extra` SHALL ser recusado com 409 `extra_not_allowed` ("Esta dívida não aceita amortização extra.") quando a dívida não aceita amortização extra.

Em Price e SAC, a amortização extra SHALL exigir o efeito, "reduzir prazo" (`reduce_term`, padrão na interface) ou "reduzir parcela" (`reduce_installment`). Com o saldo estimado logo depois do pagamento (B), taxa i, parcela P e n parcelas restantes:
- **Price, reduzir prazo:** P fica; n passa a ser o menor inteiro que quita B com parcelas P: ⌈−ln(1 − i·B/P) / ln(1 + i)⌉, ou ⌈B/P⌉ com i = 0.
- **Price, reduzir parcela:** n fica; P passa a ser B·i / (1 − (1 + i)^−n), ou B/n com i = 0, arredondada para cima ao centavo (para quitar em n meses, sem sobra de centavos).
- **SAC, reduzir prazo:** a amortização de antes do pagamento (saldo anterior ÷ n) fica; n passa a ser ⌈B / amortização⌉.
- **SAC, reduzir parcela:** n fica (a amortização passa a ser B ÷ n).

A interface SHALL mostrar o contrato recalculado já preenchido e editável, para a pessoa corrigir com os números do banco. A API SHALL gravar o contrato enviado (parcela e parcelas restantes) com `contract_as_of` igual à data do pagamento. No Rotativo e no Sem juros, a amortização extra SHALL só reduzir o saldo, sem efeito no contrato. Se B for zero, a interface SHALL oferecer marcar a dívida como quitada.

#### Scenario: Price reduzindo prazo
- **WHEN** uma dívida Price com taxa 2% a.m., parcela R$ 500,00 e saldo R$ 5.000,00 recebe amortização extra de R$ 2.000,00 com "reduzir prazo"
- **THEN** a parcela continua R$ 500,00 e as parcelas restantes passam a 7

#### Scenario: Price reduzindo parcela
- **WHEN** a mesma dívida, com 11 parcelas restantes, recebe a amortização de R$ 2.000,00 com "reduzir parcela"
- **THEN** as parcelas restantes continuam 11 e a parcela passa a R$ 306,54

#### Scenario: Corrigir com os números do banco
- **WHEN** o recálculo sugere 7 parcelas e a pessoa troca para 8 antes de salvar
- **THEN** o contrato é gravado com 8 parcelas restantes

#### Scenario: Dívida que não aceita
- **WHEN** a pessoa registra amortização extra num consignado marcado como "não aceita"
- **THEN** a API responde 409 `extra_not_allowed`

### Requirement: Parcelas restantes acompanham os pagamentos de parcela
Em Price e SAC, as parcelas restantes exibidas SHALL ser as do contrato menos a quantidade de pagamentos do tipo `installment` com data posterior a `contract_as_of`, com mínimo de zero. A simulação SHALL partir desse número.

#### Scenario: Duas parcelas pagas depois do contrato
- **WHEN** o contrato tem 18 parcelas restantes em 2026-11-05 e há pagamentos de parcela em 2026-11-10 e 2026-12-10
- **THEN** a dívida mostra 16 parcelas restantes

### Requirement: Editar e excluir pagamentos
A pessoa SHALL poder editar a data, o valor e o tipo de um pagamento (`PUT /debts/:id/payments/:paymentId`, com `version`) e excluí-lo (`DELETE`). O saldo estimado, o destinado e as parcelas restantes SHALL ser recalculados a partir dos pagamentos que sobrarem. Editar ou excluir uma amortização extra SHALL NOT desfazer o recálculo do contrato. A interface SHALL avisar: "O contrato (parcela e prazo) não volta sozinho. Se precisar, ajuste em Editar dívida."

#### Scenario: Excluir um pagamento
- **WHEN** a pessoa exclui um pagamento de R$ 450,00 de novembro
- **THEN** o saldo estimado volta a incluir esse valor e o destinado de novembro diminui R$ 450,00

#### Scenario: Excluir amortização extra
- **WHEN** a pessoa exclui uma amortização extra que tinha reduzido o prazo para 7 parcelas
- **THEN** o pagamento some, as parcelas restantes do contrato continuam 7 e a interface mostra o aviso

### Requirement: Preparado para o vínculo com a tabela do mês
O esquema de `debt_payments` e de `debts` SHALL permitir, numa mudança futura, acrescentar colunas nulas `debt_payments.occurrence_id` e `debts.item_id` sem migrar dados: os pagamentos não dependem de nenhum campo do ledger, e o saldo SHALL NOT ser derivado do ledger.

#### Scenario: Nenhuma dependência do ledger
- **WHEN** um lançamento da tabela do mês é pago, editado ou excluído
- **THEN** nenhuma dívida, saldo estimado ou destinado muda

