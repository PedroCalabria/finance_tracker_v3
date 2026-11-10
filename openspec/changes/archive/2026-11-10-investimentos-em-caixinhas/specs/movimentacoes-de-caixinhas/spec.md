## ADDED Requirements

### Requirement: Aportes e resgates
A pessoa SHALL poder registrar, editar e excluir aportes e resgates de uma caixinha ativa, com data e valor em centavos maior que zero.
- A data MUST NOT estar no futuro.
- A data MUST NOT ser anterior à do valor inicial (409 `movement_before_initial`).
- Movimentar uma caixinha encerrada MUST ser recusado com 409 `investment_not_active`.

#### Scenario: Guardar
- **WHEN** a pessoa guarda R$ 500,00 em 2026-11-05 na caixinha "Reserva"
- **THEN** é gravado um aporte de 50000 em 2026-11-05 e o saldo estimado aumenta R$ 500,00

#### Scenario: Data antes do valor inicial
- **WHEN** o valor inicial é de 2026-03-10 e a pessoa registra um aporte em 2026-02-01
- **THEN** a API recusa com 409 `movement_before_initial`

#### Scenario: Caixinha encerrada
- **WHEN** a pessoa tenta guardar dinheiro numa caixinha encerrada
- **THEN** a API recusa com 409 `investment_not_active`

### Requirement: Valor inicial
O valor inicial (`initial`) SHALL ser obrigatório, único por caixinha e editável.

Excluí-lo MUST ser recusado com 409 `initial_movement_required`.

Ele MUST contar no saldo, no rendimento e no imposto, mas MUST NOT contar no resumo do mês.

#### Scenario: Excluir o valor inicial
- **WHEN** a pessoa tenta excluir a movimentação inicial
- **THEN** a API recusa com 409 `initial_movement_required`

### Requirement: Impostos retidos no resgate
O resgate SHALL registrar o valor que sai da caixinha (bruto) e os impostos retidos (`tax_cents`, de zero até o valor do resgate).
- O modal MUST pré-preencher os impostos com a estimativa do resgate e mostrar "você recebe cerca de R$ Y".
- A pessoa MUST poder corrigir o valor.
- Aporte não tem impostos.

#### Scenario: Prévia do resgate
- **WHEN** a pessoa digita um resgate de R$ 1.000,00 cuja estimativa de imposto é R$ 12,40
- **THEN** o modal mostra "Imposto estimado R$ 12,40 · você recebe cerca de R$ 987,60" e o campo "Impostos retidos" vem com R$ 12,40

#### Scenario: Imposto maior que o resgate
- **WHEN** o corpo traz um resgate de 10000 com `tax_cents` = 20000
- **THEN** a API recusa com erro de validação

### Requirement: Trava de resgate
Uma caixinha com "Só a partir de" SHALL recusar resgates com data anterior a essa com 409 `locked_until`, com a mensagem "Só pode resgatar a partir de dd/mm/aaaa".

O card MUST mostrar "Resgate a partir de dd/mm/aaaa" e MUST NOT oferecer "Resgatar" antes da data.

#### Scenario: Resgate antes da data
- **WHEN** a caixinha só pode ser resgatada a partir de 2028-03-15 e a pessoa tenta resgatar em 2026-11-10
- **THEN** a API recusa com 409 `locked_until`

### Requirement: Resgate limitado ao saldo estimado
Um resgate maior que o saldo estimado na data dele SHALL ser recusado com 409 `withdrawal_exceeds_balance`, com a mensagem "O resgate é maior que o saldo estimado (R$ X). Se o banco mostra mais, atualize o saldo da caixinha."

Na edição, o resgate editado não entra no saldo usado na comparação.

#### Scenario: Resgate acima do saldo
- **WHEN** o saldo estimado em 2026-11-10 é R$ 1.200,00 e a pessoa tenta resgatar R$ 1.500,00
- **THEN** a API recusa com 409 `withdrawal_exceeds_balance`

#### Scenario: Depois de atualizar o saldo
- **WHEN** a pessoa informa o saldo de R$ 1.600,00 em 2026-11-10 e repete o resgate de R$ 1.500,00 nessa data
- **THEN** o resgate é gravado
