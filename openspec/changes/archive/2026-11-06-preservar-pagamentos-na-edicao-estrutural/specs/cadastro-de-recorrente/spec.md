## MODIFIED Requirements

### Requirement: Mudar o mês de início é estrutural
Mudar o "Mês de início" na edição SHALL recriar os meses como num cadastro novo (mesmo id), seguindo a regra estrutural do ADR-0004 e a capability `edicao-estrutural`. Os meses pagos SHALL ser preservados com seus pagamentos. A mudança SHALL ser recusada com 409 `payments_not_movable` se um mês pago ficar antes do novo mês de início, e com 409 se houver parte numa fatura já paga. Meses marcados como "Só este mês" (cancelados) SHALL continuar cancelados depois da recriação, quando o mês ainda existir na sequência nova.

#### Scenario: Antecipar o início sem pagamentos
- **WHEN** uma recorrente começa em 2026-11, não tem pagamentos, e a pessoa muda o mês de início para 2026-09
- **THEN** os meses de 2026-09 até o mês atual são gravados e o item continua com o mesmo id

#### Scenario: Antecipar o início com mês pago
- **WHEN** a recorrente começa em 2026-10, tem outubro pago, e a pessoa muda o mês de início para 2026-09
- **THEN** setembro é criado pendente e outubro continua pago, com o mesmo pagamento

#### Scenario: Mudar o início com mês pago
- **WHEN** a recorrente tem outubro de 2026 pago e a pessoa muda o mês de início para 2026-11
- **THEN** a interface avisa antes de salvar e o servidor responde 409 `payments_not_movable` com "O mês pago de out/2026 ficaria antes do novo mês de início. Comece até out/2026 ou desfaça o pagamento."
