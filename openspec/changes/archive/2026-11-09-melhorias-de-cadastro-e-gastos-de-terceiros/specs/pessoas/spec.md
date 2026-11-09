## ADDED Requirements

### Requirement: Cadastro de pessoas por carteira
A carteira SHALL ter um cadastro de pessoas em `/api/wallets/:walletId/people`, com as mesmas operações e regras das categorias:
- listar as ativas (`?all=1` inclui as arquivadas);
- criar;
- renomear;
- remover.

O nome SHALL ter de 1 a 60 caracteres, sem espaços nas pontas, e ser único entre as pessoas ativas da carteira, sem diferenciar maiúsculas. Um nome repetido SHALL ser recusado com 409 `duplicate` e a mensagem "Já existe uma pessoa com esse nome.". Remover uma pessoa sem lançamentos SHALL apagá-la. Remover uma pessoa em uso SHALL arquivá-la: ela sai das listas de escolha e continua aparecendo nos lançamentos que já tinha. Só membros da carteira SHALL ter acesso.

#### Scenario: Criar pessoa
- **WHEN** a pessoa cria "Maria" na carteira
- **THEN** a API responde 201 com `{ id, name: "Maria", archived: false }`

#### Scenario: Nome repetido
- **WHEN** já existe "Maria" ativa e a pessoa tenta criar "maria"
- **THEN** a API responde 409 `duplicate` com "Já existe uma pessoa com esse nome."

#### Scenario: Remover pessoa em uso
- **WHEN** "Maria" é responsável por uma despesa e a pessoa a remove
- **THEN** "Maria" é arquivada, não aparece mais no seletor de cadastro e a despesa continua mostrando "Maria" como responsável

#### Scenario: Outra carteira
- **WHEN** alguém que não é membro da carteira chama `/api/wallets/:walletId/people`
- **THEN** a API recusa o acesso, como nas outras rotas financeiras

### Requirement: Aba Pessoas na tela de Categorias
A tela de Categorias SHALL ter três opções no seletor do topo: "Despesas", "Entradas" e "Pessoas". A opção "Pessoas" SHALL listar as pessoas ativas, com criar, renomear e remover, como as categorias. O item do menu SHALL continuar "Categorias".

#### Scenario: Cadastrar pela tela
- **WHEN** a pessoa abre Categorias, escolhe "Pessoas" e adiciona "João"
- **THEN** "João" aparece na lista e passa a ser oferecido no seletor "Responsável" dos lançamentos

### Requirement: Responsável do lançamento
Todo lançamento SHALL ter um responsável: uma pessoa da carteira ou "Eu" (`personId` nulo, o padrão). O responsável SHALL valer para todas as parcelas e meses do lançamento. `OccurrenceRow` e `ItemDetail` SHALL trazer `person: { id, name } | null`. Trocar o responsável na edição (`PUT /items/:id` com `personId`) SHALL ser uma mudança simples: não recria meses e não altera pagamentos nem o item vinculado. Uma edição estrutural SHALL manter o responsável. Um `personId` de outra carteira, ou de uma pessoa arquivada que não é o responsável atual, SHALL ser recusado com 400 `validation` no campo `personId`.

#### Scenario: Cadastro sem responsável
- **WHEN** a pessoa cadastra uma entrada sem escolher responsável
- **THEN** o lançamento é gravado com `person` nulo e aparece como "Eu"

#### Scenario: Trocar o responsável de uma parcelada paga em parte
- **WHEN** uma parcelada de 3 parcelas tem a 1ª paga e a pessoa troca o responsável de "Eu" para "Maria"
- **THEN** as três parcelas passam a ter "Maria" como responsável, a 1ª continua paga com o mesmo pagamento e nenhum mês é recriado

#### Scenario: Edição estrutural mantém o responsável
- **WHEN** uma despesa única com responsável "João" é transformada em recorrente
- **THEN** os meses recriados continuam com "João" como responsável

### Requirement: Seletor de responsável nos formulários
O formulário de lançamento SHALL oferecer o seletor "Responsável" com:
- "Eu";
- as pessoas ativas, em ordem alfabética;
- "+ Nova pessoa", no fim.

"+ Nova pessoa" SHALL trocar a lista por um campo de nome. A pessoa SHALL ser criada ao salvar, antes do lançamento, e continuar escolhida se o lançamento falhar. Na edição, a pessoa atual SHALL continuar na lista mesmo arquivada.

O seletor aparece assim:
- **Entrada (cadastro e edição):** sempre, com "Eu" como padrão.
- **Edição de despesa:** sempre, com "Eu".
- **Cadastro de despesa:** só pelo checkbox "Gasto de outra pessoa" (capability `reembolso-de-terceiros`).

#### Scenario: Entrada de outra pessoa
- **WHEN** a pessoa cadastra uma entrada e escolhe "Maria" em "Responsável"
- **THEN** a entrada é gravada com "Maria" como responsável e nenhum outro lançamento é criado

#### Scenario: Nova pessoa no cadastro
- **WHEN** a pessoa escolhe "+ Nova pessoa", digita "Ana" e salva a entrada
- **THEN** "Ana" é criada na carteira e a entrada é gravada com "Ana" como responsável

#### Scenario: Cadastro de despesa sem o checkbox
- **WHEN** a pessoa abre "Adicionar despesa" e não marca "Gasto de outra pessoa"
- **THEN** o seletor "Responsável" não aparece e a despesa é gravada como "Eu"

### Requirement: Coluna Responsável na tabela do mês
A tabela do mês SHALL ter a coluna "Responsável" depois de "Categoria", com o nome da pessoa ou "Eu", ordenável pelo nome.
- Em contêiner com menos de 1280px, a coluna SHALL sair e o nome SHALL aparecer embaixo da categoria.
- Na lista de cards (abaixo de 1024px), o nome SHALL aparecer no kicker só quando o responsável não é "Eu".
- A subgrid de parcelas e meses SHALL continuar como está.

#### Scenario: Tela larga
- **WHEN** o mês tem uma despesa de "Maria" e outra sem responsável, numa tela de 1920px
- **THEN** a coluna "Responsável" mostra "Maria" numa linha e "Eu" na outra, sem rolagem horizontal na página

#### Scenario: Notebook
- **WHEN** o mesmo mês é aberto numa tela de 1440px (com o menu lateral, o contêiner da tabela fica abaixo de 1280px)
- **THEN** a coluna "Responsável" não aparece e o nome fica embaixo da categoria ("Maria" e "Eu"), sem rolagem horizontal na página

#### Scenario: Celular
- **WHEN** o mesmo mês é aberto no celular
- **THEN** o card da despesa de "Maria" mostra "Maria" no kicker e o card da outra despesa não mostra responsável
