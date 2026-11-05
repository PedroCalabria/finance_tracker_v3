## Context

Fase 1 entregue (ver `docs/PROGRESS.md`). Esta mudança corrige um bug de sessão e ajusta três fluxos de lançamentos. O estado de hoje, lido no código:

- **Sessão:**
  - `setSessionCookies` grava `ff_access` com `maxAge = ACCESS_TTL_SECONDS` (15 min). Quando o JWT vence, o navegador já apagou o cookie, e `requireUser` responde `unauthorized` (sem token), não `token_expired`. `lib/api.ts` só renova em `token_expired`.
  - Há um segundo defeito, que não estava no relato: em `routes/auth.ts`, o `/auth/refresh` chama `clearSessionCookies` em **qualquer** falha. Na corrida entre abas, a resposta 401 da aba que perdeu chega com `Set-Cookie` vazio e pode apagar os cookies que a aba vencedora acabou de receber. Os cookies são do navegador, não da aba. Só mudar o cliente não basta.
- **Recorrente:**
  - O cliente monta `date` e `dueDate`. O servidor deriva `start_month = monthOf(dueDate ?? date)` (`ruleFields`), `due_day = dia(dueDate)` e `entry_date = date`.
  - No crédito, `slotFor` usa o dia de `entry_date` como dia da cobrança e `start_month` como mês da primeira cobrança.
  - Na edição, `rebuild` recua `dueDate` k meses para achar a primeira.
- **Parcelada fora do crédito:** `date` + `dueDate` opcional. Sem `dueDate`, as parcelas ficam sem data e caem em `monthOf(date)+k`.
- **Exclusão:**
  - `deleteItem` faz exclusão lógica e recusa se houver fatura não aberta.
  - `endRecurring(lastMonth)` apaga as ocorrências seguintes **sem pagamento** e mantém as pagas, que ficam órfãs depois do fim.
  - No crédito, a interface envia `row.competenceMonth` (mês da fatura) como `lastMonth`, mas `end_month` é comparado com **meses de cobrança** em `chargeMonths`. São unidades diferentes.
  - As ações ficam escondidas nas linhas projetadas.
- O status `canceled` já é respeitado em `remainingCents`, nos totais da fatura (`invoices.ts`), nos atrasados (`listOccurrences` filtra `pending/partial`), no resumo diário e em `addPayment`. `ensureMaterialized` e `projectionsFor` não recriam um mês que já tem ocorrência, qualquer que seja o status.

## Goals / Non-Goals

**Goals:**
- A sessão não cai enquanto o refresh (30 dias) for válido, com uma ou várias abas.
- Cadastro de recorrente com "Mês de início" + dia. Obrigatoriedade e derivação verificadas no servidor e testadas.
- Parcelada fora do crédito com uma só data, que também é a `entry_date`.
- Excluir recorrente com três alcances, com recusas claras e códigos estáveis, inclusive em meses previstos.

**Non-Goals:**
- Mudar o `maxAge` do cookie, a duração dos tokens ou a detecção de reuso.
- "Restaurar" um mês cancelado. Fica para depois: hoje o caminho é cadastrar o mês como compra única.
- Exceção de data num único mês de uma recorrente pela interface. O `PATCH /occurrences/:id` continua aceitando `dueDate`, mas o formulário passa a mostrar só o dia da regra.
- Migração de dados. Itens antigos continuam válidos: `start_month`, `due_day` e `entry_date` já existem.

## Decisions

### D1. Servidor: corrida de rotação com código próprio e sem apagar cookies
Em `auth.refresh`, os casos "rotacionado há ≤ 30 s" e "perdeu o `UPDATE … where rotated_at is null`" passam a lançar `AppError(401, 'refresh_superseded', 'Sua sessão foi renovada em outra aba.')`. A rota só chama `clearSessionCookies` quando o código **não** é `refresh_superseded`. As demais falhas continuam 401 `unauthorized` com limpeza, e reuso depois de 30 s continua revogando a família.
- *Alternativa:* devolver na corrida os tokens já emitidos para a vencedora. Exigiria guardar o refresh em texto claro ou cifrado. Rejeitada.
- *Alternativa:* não mudar o servidor e confiar só na repetição do cliente. Não funciona por causa do `Set-Cookie` de limpeza.
- `requireUser` continua respondendo `unauthorized` sem cookie. O cliente passa a não depender do código, então criar `token_missing` não traria nada.

### D2. Cliente: renova em qualquer 401, serializa entre abas e repete uma vez
Algoritmo de `request()`, para URLs fora de `/api/auth/`:
1. `res = send()`. Se não for 401, segue como hoje.
2. `outcome = await renew()`:
   - Dentro da aba, deduplicado pela promessa compartilhada, como hoje.
   - Entre abas, serializado com `navigator.locks.request('ff-session-refresh', …)` quando existir (Safari 15.4+, Chrome, Firefox). Sem a API, roda sem lock.
   - Resultado: `'ok' | 'superseded' | 'failed'`. Falha de rede lança, e o cliente transforma em `offline`.
3. Se `outcome === 'superseded'`, espera 500 ms, para dar tempo de a resposta da aba vencedora gravar os cookies.
4. `res2 = send()`, sempre uma vez só, mesmo depois de `'failed'`. Se `res2` for 401, chama `onSessionLost()` e lança o erro. Falha de rede em qualquer passo lança `offline`, sem `onSessionLost`.

Com o lock, a segunda aba envia o refresh já com o cookie novo, a rotação acontece de novo sem corrida e `superseded` praticamente some. O passo 3 cobre navegadores sem Web Locks e a corrida entre dois navegadores do mesmo dispositivo com cookies compartilhados, que é rara.
- *Alternativa:* `BroadcastChannel` avisando as outras abas. Exige protocolo próprio e não impede a corrida. Rejeitada.
- *Alternativa:* aumentar o `maxAge` do cookie para além do JWT, para o servidor ver `token_expired`. Proibido pelo pedido e não resolve a corrida.

### D3. Política de repetição como função pura em `packages/shared`
`packages/shared/src/session-retry.ts` exporta `sendWithSessionRetry({ send, renew, sleep, onSessionLost })`. A função recebe as dependências e devolve a resposta final, sem `fetch` nem `navigator` dentro. Assim, os cenários (renovação ok, falha seguida de repetição ok, `superseded` com espera, perda de sessão, offline, deduplicação de N chamadas) viram testes unitários no vitest que já existe, sem instalar runner no `apps/web`. `lib/api.ts` só injeta `fetch`, `navigator.locks` e `setTimeout`.

### D4. Contrato da recorrente: `startMonth` + `day` no lugar de `date`/`dueDate`
`itemCreateInput` e `itemEditInput` ganham `startMonth: month` e `day: 1..31 | null`. Um `superRefine` por forma decide o que vale:
- **recurring:** `startMonth` obrigatório. `day` obrigatório se `type === 'income'` ou `method === 'credit'` (mensagens "Informe o dia do recebimento." e "Informe o dia da cobrança."). `date` e `dueDate` são recusados.
- **single / installment:** como hoje (`date` obrigatório). `startMonth` e `day` são recusados.

A derivação fica numa função pura, `recurringRule({ method, startMonth, day })` em `packages/shared/src/schedule.ts`, que devolve `{ startMonth, dueDay, entryDate }`:
- Fora do crédito: `dueDay = day`, `entryDate = dateInMonth(startMonth, day ?? 1)`.
- No crédito: `dueDay = null`, `entryDate = dateInMonth(startMonth, day)`. O dia de `entryDate` continua sendo o dia da cobrança que `slotFor` lê.

`ruleFields` e `writeOccurrences` passam a usá-la quando `form === 'recurring'`.
- *Por que não continuar com `date`/`dueDate` montados pelo cliente:* a regra "dia obrigatório em entrada e crédito" e o significado de cada campo ficariam só na interface. Com `startMonth`/`day`, o servidor valida exatamente o que a pessoa preencheu, e o teste unitário cobre a derivação.
- **BREAKING** só entre os nossos dois lados, que sobem juntos na mesma imagem. Não há outro consumidor da API.

### D5. Edição da recorrente
No `editItem`, quando o item e a entrada são recorrentes:
- **Estrutural:** `startMonth !== item.startMonth`; no crédito, também `day !== dia(item.entryDate)`; mais as regras de hoje (tipo, forma, crédito, cartão).
- **Simples, fora do crédito, com dia diferente de `item.dueDay`:**
  - grava `due_day` e `entry_date = dateInMonth(startMonth, day ?? 1)`;
  - grava `due_date` na ocorrência aberta e nas seguintes já gravadas, `pending` e sem pagamento, recalculando cada uma no próprio mês;
  - os meses previstos seguem a regra nova sozinhos.

  É o mesmo desenho do "valor daqui em diante" (`patchOccurrence`).
- O dia da cobrança no crédito continua **estrutural**, como hoje ("data de recorrente" no ADR-0004). Trocar o dia pode mudar a fatura de meses que já foram gravados em faturas, e `ensureMaterialized` deduplica por mês de competência: dois meses de cobrança caindo na mesma fatura fariam uma cobrança sumir. Recriar é a forma segura.
- `rebuild` deixa de recuar `dueDate` k meses quando a forma nova é recorrente: a regra vem direto de `recurringRule`. Para preservar os meses cancelados, `rebuild` passa a guardar os meses `canceled` (recorrente → recorrente, por mês de competência) e reaplica `canceled` nos meses recriados que ainda existam. Vale para os já gravados. Meses futuros cancelados são gravados de volta como cancelados.

### D6. Parcelada fora do crédito: `date` é a data da 1ª parcela
- **Cadastro:** para `installment` fora do crédito, o servidor ignora `dueDate` e usa `date` como data p/ pagamento da 1ª parcela. A parcela k vence em `addMonthsToDate(date, k)` e `entry_date = date`. A interface envia só `date`. A função pura `installmentDueDates(firstDue, n)` vai para `schedule.ts`, com teste, e `writeOccurrences` passa a usá-la.
- **Edição:** o formulário mostra "Data p/ pagamento desta parcela" e envia `dueDate` (a data da parcela aberta).
  - O servidor calcula `first = addMonthsToDate(dueDate, −(n−1))`, onde n é a posição da parcela aberta.
  - É **estrutural** se a data enviada difere da data atual da parcela aberta. Comparar com a parcela aberta, e não com a 1ª recalculada, evita um falso positivo quando o dia 31 foi encurtado num mês curto. Nesse caso, `rebuild` com `date = first`.
  - Se a parcela aberta não tinha data e `dueDate` chega nulo, não é estrutural. Isso protege itens cadastrados antes desta mudança.
  - `date` enviado pela interface na edição de parcelada fora do crédito passa a ser ignorado na detecção estrutural.
- No crédito, nada muda: `date` = data da compra.

### D7. Excluir recorrente: três endpoints, um por alcance
| Opção | Endpoint | Domínio |
| --- | --- | --- |
| Só este mês | `POST /occurrences/:id/cancel` (aceita `p_…`) | `cancelRecurringMonth` em `domain/occurrences.ts` |
| Este e os próximos | `POST /items/:id/end` com `{ occurrenceId }` (substitui `lastMonth`) | `endRecurringFrom` em `domain/items.ts` |
| Toda a recorrência | `DELETE /items/:id` | `deleteItem` (sem mudança de regra) |

Cada recurso fica no seu lugar REST. Um único `POST /items/:id/remove { scope }` misturaria três regras de recusa num endpoint.

**`cancelRecurringMonth`**, em transação:
1. Se o id é projeção, confere que ela é do item e chama `materializeProjection`.
2. Recusa com `not_recurring` se o item não for recorrente.
3. Se o status já é `canceled`, devolve a linha (idempotente).
4. Recusa com `month_has_payment` se houver pagamento, e com `month_in_paid_invoice` se `invoice.status !== 'open'`.
5. Grava `status = 'canceled'` e `version + 1`.

Fatura aberta não precisa de ajuste: o total já ignora `canceled`.

**`endRecurringFrom(occurrenceId)`**:
1. O mês de competência X vem da ocorrência ou da projeção.
2. O mês de cobrança dela:
   - fora do crédito, `c = X`;
   - no crédito, o primeiro `c` em `[X−2, X]` com `slotFor(c).competenceMonth === X`, usando a mesma função das projeções.
3. Recusa com `later_months_paid` se alguma ocorrência com competência ≥ X tiver pagamento ou estiver em fatura não aberta.
4. Se `c <= item.startMonth`, executa a exclusão lógica (mesma função de `deleteItem`).
5. Senão grava `end_month = c − 1` e apaga as ocorrências com competência ≥ X. Todas estão sem pagamento, pelo passo 3.

Assim se corrige também a mistura de unidades no crédito. O contrato `lastMonth` sai. O único chamador era a interface e um teste.

**Códigos.** `conflict()` em `errors.ts` ganha um parâmetro opcional `code`, com padrão `'conflict'`. Códigos novos, com mensagens prontas:
- `month_has_payment` (409): "Este mês já tem pagamento. Desfaça o pagamento antes de excluir o mês."
- `month_in_paid_invoice` (409): "Este mês está numa fatura já paga. Desfaça o pagamento da fatura antes de excluir o mês."
- `later_months_paid` (409): "Há pagamento neste mês ou depois. Desfaça esses pagamentos antes de encerrar."
- `not_recurring` (400): "Só lançamentos recorrentes podem ser excluídos por mês."

Em recorrentes, a mensagem de recusa do `deleteItem` por fatura paga passa a sugerir "Este e os próximos". O código fica `conflict`, como hoje.

### D8. Interface
- **`MonthInput`** (`components/ui.tsx`): dois `<select className="ff-select">` (mês por extenso; ano de `atual−5` a `atual+5`, sempre incluindo o ano do valor) dentro de um `role="group"` com `aria-labelledby` no rótulo do `Field`, e `aria-label` "Mês" e "Ano". Emite `YYYY-MM`. O layout vai em `app.css` só com tokens.
- **`DayInput`:** `ff-input` com `inputMode="numeric"`, 1–31. A dica sobre o dia 31 aparece sempre: "Nos meses mais curtos, vale o último dia."
- **`ItemFormModal`:** para `form === 'recurring'`, troca "Data" e "Vencimento" por "Mês de início" + dia, com rótulo por tipo e método (spec). Para parcelada fora do crédito, um único campo de data com o rótulo da spec. `sentDate`, `sentDue` e `structural` passam a seguir D4–D6. O aviso "recalcula todos os meses" acrescenta "Os meses excluídos continuam excluídos." quando a recorrente tiver mês cancelado.
- **`EditOccurrenceModal`:**
  - `actions` passa a existir nas linhas projetadas, só com "Excluir".
  - Para recorrente, `confirm === 'delete'` abre `DeleteRecurringDialog`: três opções em `<fieldset>` com rádios nativos (classe `app-choice` em `app.css`, com tokens), descrição de cada opção, nenhuma marcada, confirmar desabilitado até escolher.
  - "Toda a recorrência" mostra o aviso da spec quando há meses pagos.
  - O botão "Encerrar a partir deste mês" e o estado `'end'` saem.

## Risks / Trade-offs

- **[Risco]** Repetir a requisição depois de uma renovação falha dobra uma chamada que ia falhar de qualquer jeito. → É uma requisição a mais, só no caminho de sessão perdida.
- **[Risco]** Requisição não idempotente (POST) repetida depois de 401. → O 401 vem do `requireUser`, antes do handler, então nada foi gravado. A repetição é segura.
- **[Risco]** A espera de 500 ms em `superseded` não é garantia. → Com Web Locks, o caso quase não ocorre. Sem lock, a pior consequência é a ida ao login de hoje, mas sem apagar os cookies da outra aba (D1), que continua logada.
- **[Trade-off]** O formulário da recorrente deixa de permitir uma data diferente num mês só. → Fica registrado como não-objetivo. O `PATCH /occurrences/:id` ainda aceita, e dá para expor depois.
- **[Risco]** Itens antigos com `entry_date` diferente de `start_month`/dia, criados no modelo anterior. → A edição lê `startMonth` e `dueDay` do item, não de `entry_date` (exceto o dia da cobrança no crédito, que sempre veio de `entry_date`), e a comparação estrutural usa os mesmos campos. Abrir e salvar sem mexer não recria nada. Um teste cobre isso.
- **[Risco]** Uma parcelada antiga com `entry_date` diferente da data da 1ª parcela. → A detecção estrutural compara com a data atual da 1ª parcela, não com `entry_date` (D6).
- **[Trade-off]** "Este e os próximos" agora remove também o mês escolhido. Antes, "Encerrar a partir deste mês" mantinha esse mês como o último. → O rótulo novo deixa isso explícito, e o ADR registra a mudança.

## Migration Plan

1. Sem migração SQL. A interface e o servidor sobem juntos na mesma imagem (ADR-0008), então a quebra de contrato não tem janela.
2. Rollback: voltar a imagem anterior. Meses `canceled` criados por "Só este mês" continuam válidos na versão anterior, que já conhece o status.

## Open Questions

- "Só este mês" deveria ganhar um "Desfazer" no aviso rápido (toast)? Não está no pedido. Fica proposto como melhoria seguinte, junto com "Restaurar este mês".
- O dia da cobrança no crédito como mudança simples: ficou estrutural (D5) por segurança. Se a pessoa quiser simples, é preciso definir o que acontece com faturas já gravadas.
