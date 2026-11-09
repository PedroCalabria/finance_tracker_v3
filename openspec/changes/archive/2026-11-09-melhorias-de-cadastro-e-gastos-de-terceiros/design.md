## Context

**Cadastro e formulário.**
- O cadastro de lançamentos passa por `createItemTx` (`apps/server/src/domain/items.ts`).
- `createItemTx` grava o item e as ocorrências (`writeOccurrences`). Com `alreadyPaid`, quita fora do crédito o que venceu até hoje, na data de vencimento.
- O formulário (`ItemFormModal`) serve ao cadastro e à edição. Na parcelada, o padrão de "Já foi pago?" é "Não" (`suggestedPaid`).
- A importação também usa `createItemTx`, mas só com compras únicas (`alreadyPaid: true`) e com parceladas no crédito vindas da fatura (sem `alreadyPaid`).

**Faturas e crédito.**
- Itens no crédito não têm pagamento próprio. O status vem da fatura (ADR-0005).
- `ensureInvoice` cria a fatura sob demanda.
- Abrir um mês cria faturas vazias para os cartões ativos. Por isso, uma fatura passada pode existir vazia antes do cadastro.
- `payInvoiceTx` paga uma fatura dentro de uma transação aberta e gera o "Ajuste da fatura" quando o valor real difere dos itens.

**Hoje não existe:**
- nenhuma noção de pessoa ou de "de quem é" o lançamento: `created_by`/`paid_by` guardam usuários do app;
- nenhum vínculo entre dois itens comuns: `source_invoice_id` é só dos itens de sistema da fatura.

**Cards e componentes.**
- Os cards (`SummaryCards`) usam `Summary` (`domain/summary.ts`): recebido/a receber, pago/a pagar e balanço realizado/previsto.
- O design system não tem campo numérico com setas. Os componentes de formulário próprios ficam em `components/ui.tsx` (`MoneyInput`, `MonthInput`, `DayInput`).

## Goals / Non-Goals

**Goals:**
- Registrar o responsável de cada lançamento e mostrá-lo na tabela.
- Criar o reembolso de um gasto de terceiro no mesmo cadastro, com datas coerentes com quando o dinheiro deve voltar.
- Cadastrar compras parceladas antigas sem gerar atrasos falsos, inclusive no crédito, sem quitar faturas que tenham outros itens.
- Pequenos ajustes de formulário e de leitura dos cards, sem mudar regras de cálculo.

**Non-Goals:**
- Propagar edições da despesa para o reembolso.
- Filtro ou relatório por pessoa ("quanto cada um me deve").
- Aplicar "meses anteriores pagos" às recorrentes.
- Ligar pessoas a usuários da futura carteira familiar.
- Mudar a importação.

## Decisions

### 1. Pessoas como catálogo próprio, igual a categorias
A tabela `people` tem `wallet_id`, `name`, `archived_at`, `version` e `created_at`. O índice único é `(wallet_id, lower(name))` entre as ativas. A coluna `items.person_id` é `uuid null`, com `on delete set null`; nulo significa "Eu".

As rotas e a regra de remoção copiam as de categorias:
- remover pessoa sem uso apaga;
- remover pessoa em uso arquiva;
- renomear vale para todos os lançamentos.

- *Alternativa: texto livre com sugestões.* É mais simples, mas sujeito a "Maria" × "maria" e sem renomear. A pessoa preferiu escolher numa lista.
- *Alternativa: usar `wallet_members`.* Terceiros não são usuários do app.

`OccurrenceRow` e `ItemDetail` ganham `person: { id, name } | null`, carregado como a categoria em `domain/occurrences.ts` (consulta por ids, sem `Promise.all` com `tx`). Arquivada, a pessoa continua aparecendo nas linhas.

### 2. Responsável é atributo do item, editado como mudança simples
O responsável vale para o lançamento inteiro (todas as parcelas e meses). Em `editItem`, `personId` entra no grupo das mudanças simples: atualiza `items.person_id` e não recria meses. A edição estrutural (`rebuild`/`ruleFields`) não toca em `person_id` nem em `reimburses_item_id`.

### 3. Reembolso: regra pura de mapeamento + criação na mesma transação
O módulo novo `packages/shared/src/reimbursement.ts` exporta `reimbursementInput(expense, firstCharge)`. A função devolve o `ItemCreateInput` da entrada:
- `type: 'income'`, mesma `description`, `amountCents` e `form`;
- `installments` na parcelada;
- `variableAmount` na recorrente;
- `method: 'pix'`;
- `accountId`: a conta da despesa fora do crédito; sem conta no crédito;
- `personId`: a pessoa da despesa;
- `categoryId`: preenchida pelo servidor.

As datas dependem da forma e do método:
| Despesa | Entrada |
| --- | --- |
| Única fora do crédito | Única, `date` = `dueDate` = `dueDate ?? date` da despesa |
| Única no crédito | Única, `date` = `dueDate` = vencimento da 1ª fatura |
| Parcelada fora do crédito | Parcelada, `date` = data da 1ª parcela |
| Parcelada no crédito | Parcelada, `date` = vencimento da 1ª fatura (faturas vencem no mesmo dia do mês, então a regra "mesmo dia nos meses seguintes" bate) |
| Recorrente fora do crédito | Recorrente, mesmo `startMonth` e mesmo `day` |
| Recorrente no crédito | Recorrente, `startMonth` = mês da fatura da 1ª cobrança, `day` = dia do vencimento dessa fatura |

`firstCharge` (`{ competenceMonth, dueDate }`) é calculado pelo servidor só no crédito, depois de gravar a despesa:
- única e parcelada: a 1ª ocorrência gravada;
- recorrente: a regra de `slotFor`/`chargeMonthFor` aplicada ao `startMonth`, porque a 1ª ocorrência pode ainda não estar gravada (mês futuro = projeção).

**Refinamento do pedido.** O pedido dizia "mesmo mês de início" para a recorrente no crédito. Foi refinado para "mês da fatura da 1ª cobrança", porque é quando o dinheiro deve voltar: uma cobrança no dia 28 pode cair na fatura do mês seguinte.

**Recorrente fora do crédito sem dia.** A entrada recorrente exige dia. Por isso, com "Gasto de outra pessoa" marcado, o "Dia para o pagamento" passa a ser obrigatório: o servidor responde 400 em `day` com "Informe o dia: o reembolso usa o mesmo dia." É melhor do que inventar um dia.

**Categoria "Gasto de terceiros".** É procurada entre as categorias de entrada ativas da carteira, pelo nome, sem diferenciar maiúsculas. Se não existir, é criada na mesma transação.
- *Alternativa: semear em todas as carteiras.* Exige migração de dados e volta a faltar se a pessoa arquivar a categoria.

A entrada é criada chamando o próprio `createItemTx`, com o `pastInstallmentsPaid` da despesa. Assim a regra de quitação é uma só. O `alreadyPaid` da única e da recorrente não é repassado: pagar a despesa hoje não quer dizer que a pessoa já devolveu, então o reembolso nasce a receber. Em seguida, `reimburses_item_id` recebe o id da despesa.

### 4. Vínculo só para exibir e excluir
- A coluna `items.reimburses_item_id` (`uuid null`, referência a `items.id`, `on delete set null`) fica **na entrada**. Uma despesa tem no máximo um reembolso.
- `ItemDetail` ganha `reimbursement: { id, description } | null` na despesa (o reembolso não excluído) e `reimburses: { id, description } | null` na entrada.
- `DELETE /items/:id?withReimbursement=1` faz a exclusão lógica da despesa e do reembolso na mesma transação. Sem o parâmetro, só a despesa sai e o reembolso continua, com o vínculo apontando para um item excluído, que deixa de ser exibido.
- As outras exclusões ignoram o vínculo: "Só este mês", "Este e os próximos" e cancelar parcelas.
- *Alternativa: propagar edições.* Exigiria dobrar a edição estrutural e decidir o que fazer com recebimentos já feitos. Ficou fora do escopo por escolha.

### 5. Parcelas de meses anteriores: campo novo, regra por competência
`itemCreateInput` ganha `pastInstallmentsPaid?: boolean`, que só vale na parcelada. Na parcelada, `alreadyPaid` é ignorado: nenhum cliente o enviava como Sim, porque o padrão era "Não" e a importação não o usa em parceladas.

Com `pastInstallmentsPaid`:
- **Fora do crédito:** cada ocorrência com `competenceMonth < clock.currentMonth` recebe um pagamento do valor previsto, em `paidAt` = data de vencimento da ocorrência, com `status = 'paid'`. A parcela do mês atual fica em aberto mesmo vencida: a pessoa marca, como no dia a dia.
- **No crédito:** para cada fatura das ocorrências com `referenceMonth < currentMonth`, a fatura é paga com `payInvoiceTx` (real = pago = total da fatura, `paidAt` = vencimento) se:
  - ainda está `open`;
  - não tem pagamentos;
  - suas ocorrências ativas, fora as deste item, são zero.

  Faturas que já tinham itens ou pagamentos não mudam.

O critério "sem outros itens nem pagamentos" substitui "criada por este cadastro", porque abrir o mês já cria faturas vazias. O efeito para a pessoa é o mesmo: só a fatura que existe por causa desta compra é quitada.

- *Alternativa: pagar toda fatura passada aberta.* Quitaria em silêncio outros itens que a pessoa ainda acompanha.
- *Alternativa: pagamento próprio em ocorrência no crédito.* Quebra a regra "tudo passa pela fatura".

A pergunta só aparece quando a 1ª parcela cai antes do mês atual:
- fora do crédito: mês de `date`;
- no crédito: o `referenceMonth` da prévia da fatura, que o formulário já busca.

Uma regra pura `firstInstallmentMonth` não é necessária: a comparação é direta.

### 6. Parcelada abre no Crédito
O formulário guarda `methodTouched` (como `paidTouched`). No cadastro de despesa, enquanto `methodTouched` for falso:
- escolher Parcelada com algum cartão ativo põe `method = 'credit'`; a pré-seleção do cartão único já existe no efeito de contas;
- voltar para Única ou Todo mês restaura `pix`.

Nada muda na edição: lá, trocar o método é estrutural e pode ser recusado com pagamentos. Nas entradas também nada muda, porque não há crédito.

### 7. `StepperInput`
Componente em `components/ui.tsx`. Props: `id`, `value: number | null`, `onChange`, `min`, `max`, `incLabel` e `decLabel`.
- O `<input inputMode="numeric">` aceita só dígitos.
- As duas setas são `<button type="button" tabIndex={-1}>`, empilhadas à direita e dentro da caixa. Ficam fora da ordem de tabulação: o teclado usa ↑/↓ no próprio campo.
- Usam `aria-label` e ficam desabilitadas nos limites.
- O clique soma ou subtrai 1, limitado a [min, max]; vazio + ↑ vira `min`.
- O estilo `app-stepper` fica em `app.css`, só com tokens. A caixa continua sendo `ff-input`, com `padding-right` para as setas.
- O ícone `up` entra em `Icon.tsx`.

`<input type="number">` foi descartado: não mostra setas no Safari do iPhone e não segue os tokens.

### 8. Cards: previsto calculado no servidor
`Summary.income` e `Summary.expense` ganham `forecastCents`:
- entradas: `receivedCents + pendingCents`;
- gastos: `paidCents + pendingCents`.

`balance.forecastCents` não muda. `SummaryCards` só troca o que fica no valor grande e o que fica na linha de baixo. O cálculo continua num lugar só (ADR-0004).

### 9. Interface do responsável
- `PersonSelect` em `components/ui.tsx` reúne:
  - opção "Eu" (valor vazio), opcional por prop;
  - as pessoas ativas em ordem alfabética (mais a atual, se arquivada);
  - "+ Nova pessoa", que troca para um campo de nome.
- A pessoa nova é criada ao salvar, antes do lançamento (como a categoria nova), e a escolha fica guardada se o lançamento falhar.
- **Entrada:** o seletor aparece sempre.
- **Cadastro de despesa:** o checkbox "Gasto de outra pessoa" mostra o seletor sem "Eu", obrigatório, e envia `createReimbursement: true`.
- **Edição de despesa:** o seletor aparece sempre, com "Eu".
- **Tabela:**
  - coluna `app-col-person` depois de Categoria, ordenável por nome ("Eu" ordena como vazio);
  - abaixo de 1280px de contêiner, a coluna some e o nome aparece embaixo da Categoria (`app-person-inline`), como Método/Banco;
  - no celular, o nome entra no kicker só quando não é "Eu";
  - a subgrid usa `colSpan` 11.

## Risks / Trade-offs

- **[Reembolso e despesa divergem depois de editar a despesa]** → É uma escolha consciente. Os dois formulários mostram o vínculo, para a pessoa lembrar de ajustar o outro.
- **[Pagar uma fatura passada automaticamente esconde uma fatura que não foi paga de verdade]** → Só acontece com Sim explícito (padrão, mas visível) e só em faturas sem outros itens. Dá para desfazer pelo bloco de faturas, como qualquer pagamento.
- **[Despesa excluída sem o reembolso deixa uma entrada "órfã"]** → É intencional: o dinheiro pode ainda voltar. O vínculo some da tela, mas a entrada continua editável e excluível.
- **[Tabela com 11 colunas]** → A coluna recolhe abaixo de 1280px. O roteiro de verificação em 1440px, 1920px, 900px e celular confere que não há rolagem horizontal na página.
- **[Dia obrigatório na recorrente de terceiro]** → É uma regra a mais no formulário, mas evita um reembolso sem data, que ficaria sem lembrete.
- **[`alreadyPaid` ignorado na parcelada]** → É uma mudança silenciosa de API. Só o próprio cliente usava o campo, e o ADR-0004 registra a mudança.

## Migration Plan

1. Alterar `schema.ts` e rodar `npm run db:generate`. A migração cria `people` e as colunas `person_id` e `reimburses_item_id`, todas nulas. Não há migração de dados.
2. Depois do deploy, os itens existentes ficam com responsável "Eu" e sem vínculo.
3. **Reversão:** voltar a imagem anterior. As colunas novas nulas não atrapalham o código antigo. Se for preciso, uma migração de remoção apaga as colunas e a tabela.

## Open Questions

Nenhuma bloqueante. Se a coluna "Responsável" atrapalhar a leitura em 1440px, uma alternativa é mostrá-la só quando o mês tiver algum lançamento de outra pessoa (decidir no roteiro de verificação).
