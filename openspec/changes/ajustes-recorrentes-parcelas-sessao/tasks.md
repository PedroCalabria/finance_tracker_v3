## 1. Sessão: servidor

- [x] 1.1 Em `auth/service.ts` (`refresh`), lançar `AppError(401, 'refresh_superseded', …)` quando o token foi rotacionado há ≤ 30 s ou quando o `UPDATE` concorrente não pega a linha. Manter `unauthorized` e a revogação da família depois de 30 s.
- [x] 1.2 Em `http/routes/auth.ts`, só chamar `clearSessionCookies` quando o erro não for `refresh_superseded`.
- [x] 1.3 Testes em `apps/server/test/auth.test.ts`:
  - rota protegida sem `ff_access` → 401 `unauthorized`; refresh válido → 200; repetição → 200;
  - duas renovações com o mesmo token → uma 200 e outra 401 `refresh_superseded`, sem `Set-Cookie` de limpeza, e `/api/me` com os cookies da vencedora → 200;
  - o teste de reuso depois de 30 s continua passando.

## 2. Sessão: cliente

- [x] 2.1 Criar `packages/shared/src/session-retry.ts` com `sendWithSessionRetry({ send, renew, sleep, onSessionLost })` (D2/D3) e exportar no `index.ts`.
- [x] 2.2 Testes unitários em `packages/shared`:
  - 401 → renova ok → repete ok;
  - renova falha → repete ok, sem `onSessionLost`;
  - `superseded` → espera → repete;
  - repete 401 → `onSessionLost`;
  - offline não chama `onSessionLost`;
  - rota `/api/auth/` não renova;
  - N chamadas simultâneas → uma renovação.
- [x] 2.3 Reescrever `apps/web/src/lib/api.ts` usando a função:
  - `renew` deduplicado na aba e serializado com `navigator.locks` quando existir;
  - devolve `'ok' | 'superseded' | 'failed'` (falha de rede lança);
  - corpo `FormData` reenviável;
  - comentário do topo atualizado.
- [x] 2.4 Verificar no navegador: apagar `ff_access` nas ferramentas do navegador e navegar sem ir para `/entrar`; duas abas abertas por mais de 15 min continuam logadas.

## 3. Regras puras de datas (`packages/shared`)

- [x] 3.1 Criar `packages/shared/src/schedule.ts`:
  - `recurringRule({ method, startMonth, day })` → `{ startMonth, dueDay, entryDate }` (D4);
  - `installmentDueDates(firstDue, n)`;
  - `firstInstallmentDue(thisDue, position)`.
- [x] 3.2 Testes unitários:
  - dia 31 em fevereiro e em meses de 30 dias;
  - despesa sem dia → `dueDay` nulo e `entryDate` no dia 1;
  - crédito → `dueDay` nulo e `entryDate` no dia da cobrança;
  - recuo da 3ª parcela até a 1ª.
- [x] 3.3 Em `schemas.ts`, acrescentar `startMonth` e `day` a `itemCreateInput` e `itemEditInput`, com `superRefine` por forma:
  - recorrente exige `startMonth` e recusa `date`/`dueDate`;
  - `day` é obrigatório em entrada ("Informe o dia do recebimento.") e no crédito ("Informe o dia da cobrança.");
  - única e parcelada exigem `date` e recusam `startMonth`/`day`.
- [x] 3.4 Trocar `itemEndInput` para `{ occurrenceId }`.
- [x] 3.5 Testes unitários dos schemas: os campos de erro (`day`, `startMonth`, `date`) e as mensagens.

## 4. Recorrente e parcelada no servidor

- [x] 4.1 `domain/items.ts`, `ruleFields` e `writeOccurrences`:
  - recorrente via `recurringRule`;
  - parcelada fora do crédito usa `date` como 1ª data p/ pagamento e `entry_date` (ignora `dueDate`), via `installmentDueDates`.
- [x] 4.2 `editItem`, detecção estrutural (D5/D6):
  - recorrente: `startMonth` diferente, ou dia diferente no crédito;
  - parcelada fora do crédito: `firstInstallmentDue(dueDate, posição)` diferente da data atual da 1ª parcela (com `dueDate` nulo e sem data antes, não é estrutural);
  - parar de comparar `date` com `entry_date` nesses dois casos.
- [x] 4.3 `editItem`, mudança simples do dia fora do crédito: gravar `due_day` e `entry_date`, e recalcular `due_date` da ocorrência aberta e das seguintes gravadas, `pending` e sem pagamento.
- [x] 4.4 `rebuild`:
  - regra da recorrente direto de `recurringRule`, sem recuo de k meses;
  - parcelada com a 1ª data calculada;
  - preservar meses `canceled` de recorrente → recorrente pelo mês de competência (gravando o mês futuro cancelado, se preciso).
- [x] 4.5 Atualizar os testes de integração que criam recorrentes com `date`/`dueDate` e parceladas com `dueDate` (`finance.test.ts`, `edit-item.test.ts`, `attachments-notifications.test.ts`) para o contrato novo.
- [x] 4.6 Testes de integração novos:
  - recorrente fora do crédito sem dia (sem `due_date`) e com dia 31;
  - entrada e crédito sem dia → 400 em `day`;
  - mudar o dia a partir de um mês preserva o anterior pago e muda os seguintes;
  - mudar o mês de início sem pagamento recria; com pagamento → 409;
  - salvar sem mexer num item antigo não recria;
  - parcelada de 31/01 em 3 vezes;
  - mudar a data da 3ª parcela recria a partir da 1ª;
  - parcelada antiga sem data editando só a descrição.

## 5. Excluir recorrente no servidor

- [x] 5.1 `http/errors.ts`: `conflict(message, code = 'conflict')`.
- [x] 5.2 `domain/occurrences.ts`: `cancelRecurringMonth` (D7):
  - materializa a projeção;
  - recusa com `not_recurring`, `month_has_payment` e `month_in_paid_invoice`;
  - é idempotente.
- [x] 5.3 `domain/items.ts`: `endRecurringFrom(occurrenceId)` (D7):
  - mês de cobrança pelo `slotFor` no crédito;
  - recusa com `later_months_paid`;
  - primeiro mês → exclusão lógica;
  - senão `end_month = c − 1` e apaga as ocorrências com competência ≥ X;
  - substitui `endRecurring`.
- [x] 5.4 `deleteItem`: em recorrente, a mensagem de fatura paga sugere "Este e os próximos".
- [x] 5.5 `http/routes/wallet.ts`: `POST /occurrences/:id/cancel` e `POST /items/:id/end` com `itemEndInput` novo.
- [x] 5.6 Testes de integração em `apps/server/test/delete-recurring.test.ts`:
  - (a) mês gravado sem pagamento: sai do resumo e não volta em `ensureMaterialized`;
  - (a) projeção futura: gravada como cancelada, sem projeção depois;
  - (a) mês atrasado: sai dos atrasados;
  - (a) mês com pagamento → 409 `month_has_payment`;
  - (a) crédito em fatura aberta: o total diminui;
  - (a) crédito em fatura paga → 409 `month_in_paid_invoice`;
  - (a) item não recorrente → 400 `not_recurring`;
  - (b) a partir de um mês previsto: mantém o histórico e grava `end_month`;
  - (b) pagamento adiantado depois → 409 `later_months_paid`;
  - (b) no crédito, a fatura certa;
  - (b) no primeiro mês = exclusão lógica;
  - (c) com meses pagos: some de tudo e os pagamentos ficam no banco;
  - (c) crédito com fatura paga → 409.

## 6. Interface

- [x] 6.1 `components/ui.tsx`: `MonthInput` (dois `ff-select`, grupo acessível) e `DayInput`; estilos de layout em `styles/app.css` só com tokens.
- [x] 6.2 `ItemFormModal.tsx`, recorrente:
  - "Mês de início" + "Dia para o pagamento" (opcional), "Dia do recebimento" ou "Dia da cobrança", conforme tipo e método;
  - sem "Data" e sem "Vencimento";
  - padrão do mês = mês aberto;
  - na edição, preencher com `startMonth` e `dueDay` (ou o dia de `entryDate` no crédito);
  - enviar `startMonth` e `day`.
- [x] 6.3 `ItemFormModal.tsx`, parcelada fora do crédito:
  - um só campo obrigatório ("Data p/ pagamento da 1ª parcela" / "Data do recebimento da 1ª parcela");
  - na edição, "Data p/ pagamento desta parcela";
  - `structural` espelhando D5/D6.
- [x] 6.4 `EditOccurrenceModal.tsx`:
  - `DeleteRecurringDialog` com as três opções (rádios em `fieldset`, nenhuma marcada, aviso dos meses pagos em "Toda a recorrência");
  - ações nas linhas previstas (só "Excluir");
  - remover "Encerrar a partir deste mês";
  - erros do servidor exibidos no diálogo.
- [x] 6.5 Roteiro no navegador (Chrome e Safari/WebKit, 1440px e celular, claro e escuro):
  - cadastrar recorrente de despesa, de entrada e no crédito;
  - parcelada fora do crédito;
  - editar o dia;
  - excluir só este mês num mês previsto;
  - este e os próximos;
  - toda a recorrência com meses pagos.

## 7. Documentação e fechamento

- [x] 7.1 ADR-0003: o cookie `ff_access` vence junto com o JWT; o cliente renova em qualquer 401; `refresh_superseded` não apaga cookies; Web Locks.
- [x] 7.2 ADR-0004, tabela de regras:
  - "Mês da ocorrência", "Data das entradas" e "Parcelas" com a data única;
  - "Recorrentes" com mês de início + dia;
  - "Editar um lançamento" com dia simples e mês de início estrutural;
  - trocar "Encerrar recorrente" por "Excluir recorrente" com os três alcances e as recusas;
  - "Excluir item".
- [x] 7.3 ADR-0009:
  - cliente HTTP (qualquer 401, repetição, Web Locks);
  - formulários (`MonthInput` em vez de `<input type="month">`, campos da recorrente e da parcelada);
  - diálogo de exclusão e ações nas linhas previstas.
- [x] 7.4 `docs/PROGRESS.md`: seção de ajustes com estes quatro itens e a contagem de testes atualizada.
- [x] 7.5 `npm run typecheck`, `npm test` e `npm run build` passando; ADRs e PROGRESS no mesmo commit do código.
