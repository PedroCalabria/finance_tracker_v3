## Why

Uma edição estrutural recria todas as ocorrências do lançamento, por exemplo transformar em "Todo mês" uma despesa única importada do extrato. Hoje essa edição é recusada com 409 assim que existe qualquer pagamento. A recusa protege os dados: apagar a ocorrência apaga em cascata o pagamento, deixa o comprovante órfão e desfaz o vínculo com a linha do extrato. Só que, para a pessoa, o bloqueio não faz sentido quando o pagamento tem um lugar óbvio na sequência nova (o pagamento de outubro continua em outubro). As saídas oferecidas também são ruins: desfazer o pagamento perde a conciliação, e cadastrar de novo duplica o trabalho.

## What Changes

- A edição estrutural passa a **preservar as ocorrências pagas**. Cada uma é reposicionada no lugar equivalente da sequência nova (mesmo id), e só as ocorrências sem pagamento são apagadas e recriadas. Pagamentos, comprovantes, vínculos com linhas importadas e observações continuam intactos.
- O lugar equivalente é encontrado por uma regra pura e compartilhada:
  - de parcelada para parcelada, pelo número da parcela;
  - para única, a ocorrência paga vira a única;
  - nos demais casos, pelo mesmo mês.
- O 409 continua só quando o pagamento não tem para onde ir, com uma mensagem que diz o motivo:
  - troca entre despesa e entrada;
  - mudança para o crédito, que não tem pagamento próprio;
  - mês pago antes do novo mês de início, ou fora do fim da recorrência;
  - parcela paga que deixaria de existir, ou mês pago sem parcela no mesmo mês;
  - mais de uma ocorrência paga indo para uma compra única ou para o mesmo lugar.
- O código de erro desses casos passa a ser estável: `payments_not_movable`.
- A recusa por **fatura já paga** continua como está.
- O formulário de edição usa a mesma regra para avisar antes de salvar. Quando os pagamentos cabem na sequência nova, o aviso informa que eles continuam nos meses equivalentes.

## Capabilities

### New Capabilities
- `edicao-estrutural`: o que acontece com ocorrências, pagamentos e vínculos quando uma edição recria os meses de um lançamento, e quando ela é recusada.

### Modified Capabilities
- `cadastro-de-recorrente`: mudar o mês de início deixa de ser recusado por qualquer pagamento. A recusa passa a valer só para o mês pago que ficaria antes do novo início.
- `cadastro-de-parcelada`: mudar a data de uma parcela deixa de ser recusado por qualquer pagamento. As parcelas pagas continuam com seus pagamentos.

## Impact

- **Compartilhado:** novo módulo puro `packages/shared/src/rebuild.ts` (`paidTargets`), com testes unitários.
- **Servidor:** `domain/items.ts` (`rebuild` e `writeOccurrences`, que passa a reaproveitar ocorrências pagas). Não muda o schema nem a API: o mesmo `PUT /items/:id` responde 200 onde antes respondia 409.
- **Interface:** `month/ItemFormModal.tsx` (o aviso `blocked` passa a usar `paidTargets`).
- **Testes:** os testes de integração que esperam 409 por pagamento em edição estrutural (`edit-item.test.ts`, `recurring-installments.test.ts`) passam a esperar a preservação, e entram testes novos (única paga → recorrente, recusas).
- **Docs:** ADR-0004 (linha "Editar um lançamento") e `docs/PROGRESS.md`.
