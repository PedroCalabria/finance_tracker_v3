# exclusao-de-recorrente

## Purpose

As três formas de excluir uma recorrente (só este mês, este e os próximos, toda a recorrência) e quando cada uma é recusada (ADR-0004, ADR-0009).

## Requirements

### Requirement: Excluir recorrente pergunta o alcance
Ao clicar em "Excluir" numa recorrente, a interface SHALL abrir um diálogo com três opções: "Só este mês", "Este e os próximos" e "Toda a recorrência". Cada opção SHALL ter uma frase curta dizendo o que acontece. Nenhuma opção SHALL vir marcada por padrão, e o botão de confirmar SHALL ficar desabilitado até a pessoa escolher. Única e parcelada SHALL continuar com a confirmação simples de hoje. O botão "Encerrar a partir deste mês" SHALL deixar de existir.

#### Scenario: Abrir o diálogo
- **WHEN** a pessoa abre a linha de "Internet" (recorrente) de dezembro e clica em "Excluir"
- **THEN** ela vê as três opções, nenhuma marcada, e o botão "Excluir" desabilitado

#### Scenario: Compra única
- **WHEN** a pessoa clica em "Excluir" numa compra única
- **THEN** aparece a confirmação simples de hoje, sem escolha de alcance

### Requirement: Ações também nos meses previstos
A linha de um mês previsto (projeção `p_<itemId>_<mês>`) SHALL mostrar a ação "Excluir" com o mesmo diálogo. As ações que não se aplicam a um mês previsto, como mover de fatura, SHALL continuar escondidas.

#### Scenario: Excluir um mês futuro
- **WHEN** a pessoa navega até março de 2027, abre a linha prevista de "Academia" e escolhe "Só este mês"
- **THEN** março de 2027 é gravado como cancelado e a linha aparece com o selo "Cancelado"

### Requirement: Só este mês
"Só este mês" (`POST /occurrences/:id/cancel`) SHALL marcar a ocorrência com status `canceled`. Se o id for de uma projeção, o servidor SHALL gravá-la antes por `materializeProjection`. O mês cancelado SHALL sair dos cards, dos totais da fatura, dos atrasados e dos lembretes. Ele SHALL continuar visível no mês com o selo "Cancelado", e `ensureMaterialized` e as projeções SHALL NOT recriá-lo. A ação SHALL ser recusada:
- com 409 `month_has_payment`, se o mês tiver pagamento, e a mensagem SHALL orientar a desfazer o pagamento antes;
- com 409 `month_in_paid_invoice`, se o mês estiver numa fatura que não está aberta, e a mensagem SHALL orientar a desfazer o pagamento da fatura antes;
- com 400 `not_recurring`, se o lançamento não for recorrente.

Cancelar um mês já cancelado SHALL ser idempotente.

#### Scenario: Mês do passado sem pagamento
- **WHEN** a pessoa cancela outubro de uma recorrente fora do crédito que está atrasada
- **THEN** outubro fica "Cancelado", deixa de aparecer como atrasado no mês atual e sai de "a pagar" e "em atraso"

#### Scenario: Mês previsto
- **WHEN** a pessoa cancela `p_<itemId>_2027-02`
- **THEN** a ocorrência de 2027-02 é gravada com status `canceled`, e consultar fevereiro de novo não mostra uma projeção desse item

#### Scenario: Mês com pagamento
- **WHEN** o mês tem um pagamento parcial e a pessoa escolhe "Só este mês"
- **THEN** o servidor responde 409 `month_has_payment` com "Este mês já tem pagamento. Desfaça o pagamento antes de excluir o mês." e nada muda

#### Scenario: Mês numa fatura paga
- **WHEN** a assinatura no crédito de outubro está numa fatura já paga e a pessoa escolhe "Só este mês"
- **THEN** o servidor responde 409 `month_in_paid_invoice` com "Este mês está numa fatura já paga. Desfaça o pagamento da fatura antes de excluir o mês." e nada muda

#### Scenario: Mês no crédito com fatura aberta
- **WHEN** a pessoa cancela o mês de uma assinatura no crédito cuja fatura está aberta
- **THEN** a ocorrência fica cancelada e o total da fatura diminui o valor dela

### Requirement: Este e os próximos
"Este e os próximos" (`POST /items/:id/end` com `{ occurrenceId }`) SHALL encerrar a recorrência no mês de cobrança anterior ao da ocorrência escolhida, apagar as ocorrências gravadas desse mês em diante e manter o histórico anterior. No crédito, o mês de cobrança da ocorrência SHALL ser calculado pelo servidor a partir da fatura. A ação SHALL ser recusada com 409 `later_months_paid` se houver pagamento, ou parte numa fatura que não está aberta, no mês escolhido ou depois. Se a ocorrência escolhida for a primeira da recorrência, o resultado SHALL ser o mesmo de "Toda a recorrência". `occurrenceId` SHALL aceitar projeções.

#### Scenario: Encerrar a partir de dezembro
- **WHEN** uma recorrente começou em 2026-08, tem agosto a outubro pagos e novembro pendente, e a pessoa escolhe "Este e os próximos" em dezembro (previsto)
- **THEN** `end_month` vira 2026-11, agosto a novembro continuam, e dezembro em diante não aparece mais

#### Scenario: Pagamento adiantado depois do mês escolhido
- **WHEN** janeiro de 2027 já foi pago adiantado e a pessoa escolhe "Este e os próximos" em dezembro de 2026
- **THEN** o servidor responde 409 `later_months_paid` com "Há pagamento neste mês ou depois. Desfaça esses pagamentos antes de encerrar." e nada muda

#### Scenario: Primeiro mês
- **WHEN** a pessoa escolhe "Este e os próximos" no mês de início e não há pagamento
- **THEN** o lançamento é excluído (exclusão lógica), como em "Toda a recorrência"

### Requirement: Toda a recorrência
"Toda a recorrência" (`DELETE /items/:id`) SHALL manter o comportamento atual: exclusão lógica, com os pagamentos e comprovantes guardados no banco, e recusa com 409 se houver parte numa fatura já paga. O diálogo SHALL avisar, antes de confirmar, que os meses já pagos também somem das telas e dos cards.

#### Scenario: Recorrente com meses pagos
- **WHEN** a pessoa escolhe "Toda a recorrência" numa recorrente com três meses pagos
- **THEN** o diálogo mostra o aviso "Os meses já pagos também somem das telas e dos cards. Os pagamentos ficam guardados.", e, ao confirmar, o lançamento some de todos os meses

#### Scenario: Recorrente no crédito com fatura paga
- **WHEN** a pessoa escolhe "Toda a recorrência" numa assinatura que tem um mês numa fatura paga
- **THEN** o servidor responde 409 com a orientação de usar "Este e os próximos"
