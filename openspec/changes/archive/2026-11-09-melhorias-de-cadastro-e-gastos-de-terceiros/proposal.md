## Why

Os testes de uso trouxeram seis atritos no cadastro e na leitura do mês.

**Gastos de terceiros.** É comum pagar no próprio cartão um gasto que é de outra pessoa e que ela vai devolver. Hoje isso exige dois cadastros feitos à mão, e nada na tabela diz de quem é cada lançamento.

**Compras antigas.** Cadastrar uma compra parcelada que começou meses atrás deixa as parcelas passadas em aberto. Elas aparecem como atrasadas e, no crédito, geram "Fatura atrasada" em faturas que já foram pagas no banco.

**Ajustes pequenos.**
- A parcelada quase sempre é no cartão, mas o formulário abre no Pix.
- O número de parcelas só pode ser digitado.
- Os cards do mês destacam o que já foi pago, quando o que orienta o mês é o previsto.

## What Changes

- **Cadastro de pessoas por carteira.** Funciona como o de categorias e fica numa terceira aba da tela de Categorias. Cada lançamento ganha um **responsável**: uma pessoa ou "Eu", que é o padrão. A tabela do mês ganha a coluna "Responsável".
- **Responsável nos formulários.**
  - Na **entrada**, o seletor "Responsável" aparece sempre, com "Eu" como padrão.
  - No **cadastro de despesa**, o checkbox "Gasto de outra pessoa" pede a pessoa.
  - Na **edição de despesa**, aparece o seletor "Responsável".
- **Reembolso automático.** Ao cadastrar uma despesa marcada como gasto de outra pessoa, a mesma transação cria uma **entrada de reembolso**. Ela tem a categoria "Gasto de terceiros", a mesma pessoa, o mesmo valor e a mesma forma, e datas derivadas da despesa (no crédito, os vencimentos das faturas). A entrada fica vinculada à despesa.
  - Editar a despesa não mexe no reembolso.
  - Excluir a despesa inteira oferece excluir o reembolso junto.
- **Parcelas de meses anteriores.** Na parcelada, "Já foi pago?" vira "As parcelas de meses anteriores já foram pagas?", com padrão **Sim**. A pergunta só aparece quando há parcela antes do mês atual.
  - Com Sim, as parcelas de competência anterior ao mês atual nascem pagas; a do mês atual fica em aberto.
  - No crédito, as faturas passadas sem outros itens nem pagamentos são pagas pelo total.
- **Parcelada abre no Crédito.** No cadastro de despesa, escolher "Parcelada" muda o método para Crédito enquanto a pessoa não tiver mexido no método e houver um cartão.
- **Setas no número de parcelas.** Componente `StepperInput`, com setas dentro da caixa e suporte ao teclado.
- **Cards do mês com o previsto em destaque.** O valor grande de cada card passa a ser o previsto do mês, e o realizado vai para a linha de baixo. O resumo da API ganha `forecastCents` em entradas e gastos.
- **API.** Mudanças compatíveis com o cliente atual:
  - rotas `/people`;
  - `personId`, `createReimbursement` e `pastInstallmentsPaid` no cadastro;
  - `personId` na edição;
  - `?withReimbursement=1` no `DELETE /items/:id`;
  - `person`/`reimbursement`/`reimburses` nas respostas.
- **Mudança de semântica.** Na parcelada, `alreadyPaid` deixa de ser usado; vale `pastInstallmentsPaid`. Única e recorrente continuam com `alreadyPaid`.

## Capabilities

### New Capabilities
- `pessoas`: cadastro de pessoas por carteira, responsável de cada lançamento ("Eu" por padrão), seletor nos formulários e coluna "Responsável" na tabela do mês.
- `reembolso-de-terceiros`: despesa marcada como gasto de outra pessoa cria a entrada de reembolso; mapeamento de valores e datas; vínculo e exclusão conjunta.
- `resumo-do-mes`: o que cada card do mês mostra em destaque (previsto) e na linha de baixo (realizado), e de onde vêm os totais.

### Modified Capabilities
- `cadastro-de-parcelada`: parcelas de meses anteriores entram pagas por padrão (inclusive faturas passadas no crédito), a parcelada abre no Crédito e o número de parcelas ganha setas.

## Impact

- **Banco:** tabela nova `people` e colunas `items.person_id` e `items.reimburses_item_id`. A migração é gerada em `apps/server/drizzle/`.
- **Compartilhado:**
  - `schemas.ts`: entrada de pessoas e campos novos de item;
  - `api-types.ts`: `Person`, `person` em `OccurrenceRow`/`ItemDetail`, `forecastCents` em `Summary`;
  - módulo puro novo `reimbursement.ts`, com testes.
- **Servidor:**
  - `domain/catalog.ts`: pessoas;
  - `domain/items.ts`: cadastro com reembolso e parcelas passadas, edição do responsável, exclusão conjunta;
  - `domain/occurrences.ts`: `person` nas linhas;
  - `domain/summary.ts`;
  - `http/routes/wallet.ts`.
- **Interface:**
  - `pages/CategoriesPage.tsx`: aba Pessoas;
  - `month/ItemFormModal.tsx`;
  - `month/OccurrenceTable.tsx`;
  - `month/SummaryCards.tsx`;
  - `month/EditOccurrenceModal.tsx` e `month/DeleteRecurringDialog.tsx`: excluir o reembolso;
  - `components/ui.tsx`: `StepperInput` e `PersonSelect`;
  - `components/Icon.tsx`: ícone `up`;
  - `lib/queries.ts`;
  - `styles/app.css`.
- **Docs:** ADR-0004, ADR-0005 e ADR-0009, e `docs/PROGRESS.md`.
- **Importação:** não muda. Ela continua usando `alreadyPaid` só em compras únicas.
