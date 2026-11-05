## Why

O uso da fase 1 mostrou quatro problemas. O mais grave é a sessão, que cai depois de uns 15 minutos. O cookie `ff_access` expira junto com o JWT, então o servidor responde `unauthorized` e não `token_expired`. O cliente só renova a sessão em `token_expired` e manda a pessoa para `/entrar`. Os outros três estão nos cadastros de recorrente e de parcelada, que pedem datas confusas (uma "Data" que não significa nada numa recorrente, e duas datas numa parcelada), e na exclusão de recorrente, que só sabe apagar todos os meses.

## What Changes

- **Sessão:** o cliente renova a sessão em qualquer 401 fora de `/api/auth`, uma vez só, com deduplicação entre chamadas simultâneas e serialização entre abas. Depois repete a requisição original uma vez, mesmo que a renovação tenha falhado (outra aba pode já ter renovado). Só então vai para o login.
- **Sessão (servidor):** a aba que perde a corrida da rotação dentro da janela de 30 s recebe 401 com código próprio (`refresh_superseded`), e o servidor **não apaga os cookies** nessa resposta. Hoje a resposta de erro do `/auth/refresh` limpa os cookies, inclusive os que a aba vencedora acabou de receber. O `maxAge` do cookie e a detecção de reuso continuam como estão.
- **Recorrente:** o cadastro troca "Data" + "Vencimento" por **"Mês de início"** + um **dia**. Despesa fora do crédito usa "Dia para o pagamento" (opcional). Entrada usa "Dia do recebimento" (obrigatório). Crédito usa "Dia da cobrança" (obrigatório). O rótulo "Vencimento" sai da recorrente. Um seletor de mês próprio, feito com `ff-select`, substitui o `<input type="month">`, que não funciona bem no Safari.
- **Recorrente (API):** **BREAKING** em `POST /items` e `PUT /items/:id`. Com `form: "recurring"`, a API passa a receber `startMonth` + `day` e não aceita mais `date`/`dueDate`. O servidor valida e deriva `start_month`, `due_day` e `entry_date`. Não há migração de banco.
- **Recorrente (edição):** mudar o dia fora do crédito é simples e vale do mês aberto em diante, inclusive nos meses seguintes já gravados, pendentes e sem pagamento. Mudar o mês de início continua estrutural.
- **Parcelada fora do crédito:** um único campo obrigatório, "Data p/ pagamento da 1ª parcela" (na entrada, "Data do recebimento da 1ª parcela"). Ele vira também a `entry_date`, e as demais parcelas são derivadas. No crédito nada muda. Na edição continua "Data p/ pagamento desta parcela", e mudá-la é estrutural.
- **Excluir recorrente:** um diálogo pergunta o alcance:
  - "Só este mês" (novo `POST /occurrences/:id/cancel`, aceita projeção): o mês fica `canceled`.
  - "Este e os próximos" (`POST /items/:id/end` passa a receber `occurrenceId`, **BREAKING**): encerra no mês anterior e é recusado se houver pagamento dali em diante.
  - "Toda a recorrência" (`DELETE /items/:id`, como hoje): o diálogo avisa que os meses pagos também somem.
- O diálogo também fica disponível nos meses previstos. O botão "Encerrar a partir deste mês" sai.
- Erros novos com `AppError` e código estável: `refresh_superseded`, `month_has_payment`, `month_in_paid_invoice`, `later_months_paid`, `not_recurring`.

## Capabilities

### New Capabilities
- `renovacao-de-sessao`: renovação transparente do access token no cliente e comportamento do `/auth/refresh` na corrida entre abas.
- `cadastro-de-recorrente`: campos, validação e efeitos de cadastrar e editar um lançamento recorrente (mês de início e dia).
- `cadastro-de-parcelada`: data única da 1ª parcela fora do crédito, derivação das demais e edição.
- `exclusao-de-recorrente`: as três formas de excluir uma recorrente (só este mês, este e os próximos, toda a recorrência) e quando cada uma é recusada.

### Modified Capabilities
<!-- Não há specs em openspec/specs/: o comportamento atual está nos ADRs. -->

## Impact

- **Servidor:**
  - `auth/service.ts` (`refresh`) e `http/routes/auth.ts`.
  - `domain/items.ts` (`ruleFields`, `writeOccurrences`, `editItem`, `rebuild`, `endRecurring`) e `domain/occurrences.ts` (novo `cancelRecurringMonth`).
  - `http/routes/wallet.ts`, `http/errors.ts` (código no `conflict`).
- **Compartilhado:** `packages/shared/src/schemas.ts` (`itemCreateInput`, `itemEditInput`, `itemEndInput`) e um módulo puro novo (`schedule.ts`) com as regras de mês/dia e da data da 1ª parcela. Um módulo puro de política de reautenticação (`session-retry.ts`), com testes unitários.
- **Interface:** `lib/api.ts`, `month/ItemFormModal.tsx` (campos novos), `month/EditOccurrenceModal.tsx` (diálogo de exclusão e ações nas linhas previstas), `components/ui.tsx` (`MonthInput`, `DayInput`) e `styles/app.css` (opções do diálogo).
- **Testes:** os de integração que criam recorrentes com `date`/`dueDate` e o que chama `/end` com `lastMonth` (`finance.test.ts`, `edit-item.test.ts`) precisam do contrato novo. Entram testes novos em `auth.test.ts` e um arquivo de integração para a exclusão de recorrentes.
- **Docs:** ADR-0003, ADR-0004 (tabela de regras), ADR-0009 e `docs/PROGRESS.md`, no mesmo commit.
- Sem migração de banco nem dependência nova.
