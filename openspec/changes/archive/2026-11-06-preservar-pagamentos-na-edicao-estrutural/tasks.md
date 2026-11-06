## 1. Regra pura (`packages/shared`)

- [x] 1.1 Criar `packages/shared/src/rebuild.ts` com `paidTargets` (tipos `PaidSlot`, `NewSequence`, `PaidTarget`, resultado `ok`/`message`), seguindo a ordem do design: tipo, crédito, mapeamento, destinos repetidos. Exportar em `index.ts`.
- [x] 1.2 Testes unitários em `packages/shared/src/rebuild.test.ts`, cobrindo:
  - única → recorrente;
  - única → parcelada (mesmo mês e começando antes);
  - recorrente → única (um e dois meses pagos);
  - recorrente → recorrente (início antes e depois);
  - parcelada → parcelada (mais e menos parcelas);
  - parcelada → recorrente com meses fora do intervalo;
  - troca de tipo;
  - passagem para o crédito;
  - sem pagamentos (sempre ok);
  - mensagens com mês no formato `out/2026`.

## 2. Servidor (`apps/server/src/domain/items.ts`)

- [x] 2.1 `writeOccurrences`: parâmetro opcional `reuse(planned)` → mapa índice → id. As linhas reaproveitadas viram `UPDATE` (mês, parcela, data, valor, `invoice_id` nulo, `version + 1`); as demais, `INSERT`.
- [x] 2.2 `rebuild`:
  - separar as ocorrências pagas;
  - manter a recusa por fatura não aberta;
  - recusar troca de tipo e passagem para o crédito com `payments_not_movable`;
  - apagar só as sem pagamento;
  - recorrente: conferir com `paidTargets` antes de gravar e normalizar as preservadas (parcela nula, data pelo dia, `invoice_id` nulo, valor da linha aberta);
  - única e parcelada: conferir dentro de `reuse`, com os meses planejados;
  - por fim, `refreshStatus` nas preservadas.
- [x] 2.3 Garantir que a reaplicação de "Só este mês" e das observações não sobrescreva as ocorrências preservadas.

## 3. Interface (`apps/web/src/month/ItemFormModal.tsx`)

- [x] 3.1 Trocar `blocked` por `paidTargets` com os pagamentos da edição. Montar a sequência nova a partir do formulário (meses das parcelas com `firstInstallmentDue`/`installmentDueDates`). Manter a recusa por fatura não aberta.
- [x] 3.2 Aviso informativo quando houver pagamentos e todos couberem: "Essa mudança recalcula os meses deste lançamento. Os pagamentos já feitos continuam nos meses equivalentes."; perigo com a mensagem da regra quando não couberem.

## 4. Testes de integração (`apps/server/test`)

- [x] 4.1 Atualizar os testes que esperavam 409 por pagamento em edição estrutural (`edit-item.test.ts`, `recurring-installments.test.ts`) para o comportamento novo, ou para a recusa específica quando ela ainda vale.
- [x] 4.2 Testes novos:
  - única paga (vinda da importação) → recorrente, preservando pagamento, ocorrência, `import_lines` e data;
  - única paga → parcelada;
  - parcela paga com mudança de data;
  - recusas `payments_not_movable` (início depois do mês pago, menos parcelas, crédito, troca de tipo).

## 5. Documentação e verificação

- [x] 5.1 ADR-0004 (linha "Editar um lançamento") e `docs/PROGRESS.md`.
- [x] 5.2 `npm run typecheck`, `npm test` e `npm run build` verdes.
