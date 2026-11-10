# tela-de-dividas Specification

## Purpose
A tela /dividas: resumo, orçamento, lista na ordem da estratégia, timeline, comparação, quitadas, item no menu e regras de layout e acessibilidade (ADR-0009, ADR-0011).
## Requirements
### Requirement: Rota e menu
A interface SHALL ter a tela "Dívidas" em `/dividas`, com o item "Dívidas" no "Menu principal", depois de "Importar". O item SHALL marcar `aria-current="page"` quando a tela estiver aberta, como os outros.

#### Scenario: Abrir pelo menu
- **WHEN** a pessoa clica em "Dívidas" no menu
- **THEN** a tela `/dividas` abre e o item fica marcado como atual

### Requirement: Tela vazia
Sem dívidas cadastradas, a tela SHALL explicar o que ela faz e oferecer "+ Nova dívida" e "Definir orçamento".

#### Scenario: Primeira visita
- **WHEN** a carteira não tem dívidas
- **THEN** a tela mostra a explicação e os botões "+ Nova dívida" e "Definir orçamento", sem resumo, timeline ou comparação

### Requirement: Resumo
O topo da tela SHALL mostrar cards com:
- total devedor: a soma dos saldos estimados das dívidas ativas;
- previsão de quitação de todas (mês/ano, ou "não quita com este orçamento");
- juros futuros estimados;
- orçamento vigente no mês atual, com a ação "Alterar".

Os avisos do plano (`budget_short`, `not_decreasing`, `no_budget`, `never_paid_off`) SHALL aparecer logo abaixo dos cards.

#### Scenario: Resumo com orçamento
- **WHEN** há duas dívidas ativas com saldos de R$ 6.800,00 e R$ 1.200,00 e orçamento de R$ 2.000,00
- **THEN** o total devedor é R$ 8.000,00 e o card do orçamento mostra R$ 2.000,00

### Requirement: Orçamento na tela
Uma seção "Orçamento" SHALL listar, mês a mês, planejado, destinado e diferença. O mês atual aparece com "em andamento" e a diferença negativa aparece em destaque de alerta, por token. "Alterar orçamento" SHALL abrir um formulário com "A partir de" (`MonthInput`, padrão o mês atual) e o valor, e mostrar as vigências gravadas, cada uma com a ação de remover.

#### Scenario: Alterar o orçamento
- **WHEN** a pessoa abre "Alterar orçamento", escolhe 2026-12 e R$ 2.500,00
- **THEN** a vigência é gravada, o card do orçamento continua com o valor de novembro e a simulação passa a usar R$ 2.500,00 a partir de dezembro

### Requirement: Lista de dívidas
A lista SHALL mostrar as dívidas ativas na ordem da estratégia escolhida, com um seletor de estratégia (Avalanche, Bola de neve, Minha ordem) acima dela. Cada dívida SHALL mostrar:
- nome, categoria e credor;
- saldo estimado e a data da âncora vigente ("saldo informado em dd/mm");
- taxa mensal;
- parcela e parcelas restantes (Price/SAC) ou mínimo (Rotativo);
- barra de progresso do saldo inicial ao estimado, com o percentual em texto. Se o saldo cresceu, mostra 0% e "o saldo cresceu R$ X";
- pago até agora;
- previsão de quitação;
- selo "Não aceita amortização" quando for o caso.

Ações: Registrar pagamento, Atualizar saldo, Simular amortização, Editar, Marcar como quitada e Excluir (com confirmação). Clicar na dívida SHALL abrir os detalhes, com o histórico de saldos e de pagamentos (editar e excluir). Em "Minha ordem", cada dívida SHALL ter os botões ↑ e ↓ com rótulos acessíveis ("Subir <nome>", "Descer <nome>"); a primeira não tem ↑ e a última não tem ↓. A ordem é gravada a cada clique.

#### Scenario: Reordenar
- **WHEN** a estratégia é "Minha ordem" e a pessoa clica em "Subir" na segunda dívida
- **THEN** ela passa a ser a primeira, a ordem é gravada, e a timeline e as previsões são recalculadas

#### Scenario: Botões só em Minha ordem
- **WHEN** a estratégia é avalanche
- **THEN** a lista não mostra os botões ↑ e ↓

### Requirement: Formulários da dívida
O cadastro e a edição SHALL usar um único formulário modal:
- os campos aparecem conforme a estrutura (ver `cadastro-de-dividas`);
- a taxa tem o seletor "ao mês / ao ano" e mostra a taxa mensal resultante;
- os valores usam o campo de dinheiro do app, as datas `<input type="date">` e o nº de parcelas `StepperInput`;
- o credor é texto livre ou, na categoria Pessoa, o seletor de pessoas com "+ Nova pessoa".

"Registrar pagamento" SHALL pedir data (padrão hoje), valor (padrão: a parcela ou o mínimo), tipo e, na amortização extra em Price/SAC, o efeito, com o contrato recalculado editável. "Atualizar saldo" SHALL pedir data (padrão hoje), saldo e, em Price/SAC, parcelas restantes e parcela, já preenchidas.

Os erros do servidor SHALL aparecer no próprio modal e nos campos (`fields`).

#### Scenario: Valor padrão do pagamento
- **WHEN** a pessoa abre "Registrar pagamento" numa dívida Price com parcela de R$ 450,00
- **THEN** o valor vem preenchido com R$ 450,00 e o tipo com "Parcela"

### Requirement: Timeline
A tela SHALL mostrar a timeline da estratégia escolhida, com uma linha por dívida ativa na ordem da lista. Cada linha tem:
- o nome como rótulo direto;
- a área do saldo, que diminui do mês atual até o mês de quitação;
- a marca do mês em que a dívida termina.

O eixo dos meses SHALL marcar os meses quando o horizonte tem até 24 meses, e os anos quando passa disso. O gráfico SHALL ser SVG desenhado no próprio app, sem biblioteca nova, só com tokens de cor.

Para leitores de tela, o gráfico SHALL ter `role="img"` com descrição e, junto dele, uma lista em texto: "<dívida>: quita em <mês/ano>" ou "não quita com este orçamento".

#### Scenario: Quitação marcada
- **WHEN** a simulação quita o rotativo em 2027-01 e o empréstimo em 2027-04
- **THEN** a linha do rotativo termina em jan/2027 com a marca de quitação, a do empréstimo em abr/2027, e a lista em texto diz o mesmo

### Requirement: Comparação de estratégias na tela
A tela SHALL mostrar uma tabela com Avalanche, Bola de neve, Minha ordem e Só o mínimo: quitação de todas e juros futuros. A estratégia escolhida fica marcada e, quando ela não for a de menor juros, aparece a frase da diferença (ver `plano-de-quitacao`). Escolher uma linha da tabela SHALL NOT mudar a estratégia: a troca é feita só pelo seletor da lista.

#### Scenario: Estratégia escolhida marcada
- **WHEN** a estratégia é bola de neve
- **THEN** a linha "Bola de neve" aparece marcada e, se a avalanche custa menos, a diferença é mostrada

### Requirement: Quitadas
Abaixo da lista, uma seção recolhível "Quitadas" SHALL mostrar as dívidas quitadas: nome, data da quitação, total pago e o histórico ao abrir. A ação "Reabrir" fica disponível em cada uma.

#### Scenario: Reabrir
- **WHEN** a pessoa reabre uma dívida quitada
- **THEN** ela volta para a lista de ativas, no fim da ordem manual, e entra de novo na simulação

### Requirement: Layout, design system e acessibilidade
A tela SHALL seguir o ADR-0009:
- só classes `ff-*` e tokens, sem cores literais; o que faltar (barra de progresso, timeline) vai em `app.css` usando tokens;
- abaixo de 1024px, as tabelas viram cards;
- abaixo de 768px, os modais sobem da base da tela e "+ Nova dívida" vira botão flutuante;
- sem rolagem horizontal na página em nenhum tamanho, nos temas claro e escuro;
- foco preso nos modais;
- barra de progresso com `role="progressbar"` e `aria-valuenow`;
- valores e selos sempre com texto, nunca só cor.

Os dados SHALL usar TanStack Query com chaves por carteira, e qualquer mutação do módulo SHALL invalidar dívidas, plano e orçamento.

#### Scenario: Celular
- **WHEN** a tela é aberta num celular de 390px de largura
- **THEN** a lista aparece em cards, a timeline cabe na largura sem rolagem horizontal da página e "+ Nova dívida" é um botão flutuante

#### Scenario: Atualização depois de registrar
- **WHEN** a pessoa registra um pagamento
- **THEN** o saldo da dívida, o destinado do mês, o resumo, a timeline e a comparação são atualizados sem recarregar a página

