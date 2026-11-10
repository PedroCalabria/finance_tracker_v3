# tela-de-investimentos Specification

## Purpose
A tela /investimentos: CDI, cards de resumo, gráfico de evolução e projeção, caixinhas em cards, formulários, encerradas, item no menu e regras de layout e acessibilidade (ADR-0009, ADR-0012).
## Requirements
### Requirement: Rota e menu
A tela "Investimentos" SHALL ficar em `/investimentos`, com um item no menu principal (`AppShell`) junto de "Dívidas".

#### Scenario: Abrir pelo menu
- **WHEN** a pessoa clica em "Investimentos" no menu
- **THEN** a tela abre em `/investimentos` com o item do menu marcado como ativo

### Requirement: Cabeçalho e cards de resumo
O cabeçalho SHALL ter "+ Nova caixinha" e o CDI da carteira ("CDI: 14,9% a.a. · atualizado em dd/mm"), que abre o modal do CDI. Sem CDI definido, mostra "Informar CDI".

Abaixo, quatro cards:
- **Total guardado:** soma dos brutos das ativas, com "líquido R$ X";
- **Rendeu até hoje:** soma do rendimento, com "IR estimado R$ X";
- **Guardar por mês:** soma dos planos, com "em N caixinhas";
- **Este mês:** "R$ X de R$ Y" (aportado no mês atual de planejado).

#### Scenario: Leitura do resumo
- **WHEN** há duas caixinhas ativas, com brutos de R$ 12.400,00 e R$ 3.980,00, planos de R$ 500,00 e R$ 300,00, e R$ 600,00 aportados no mês
- **THEN** "Total guardado" mostra R$ 16.380,00, "Guardar por mês" mostra R$ 800,00 "em 2 caixinhas" e "Este mês" mostra "R$ 600,00 de R$ 800,00"

### Requirement: Gráfico de evolução
A tela SHALL mostrar o gráfico "Evolução" em SVG próprio, sem biblioteca, com:
- duas séries: o **aportado** (linha em `--text-muted`) e o **saldo bruto** (área em `--primary-soft` com contorno `--primary`);
- uma marca "hoje";
- a projeção tracejada.

Um `Segmented` MUST alternar entre "6 meses", "1 ano" e "Projeção 2 anos". O gráfico MUST ter `role="img"` com descrição e um resumo em texto do período ("Em 1 ano: aportou R$ X, rendeu R$ Y").

#### Scenario: Ver a projeção
- **WHEN** a pessoa escolhe "Projeção 2 anos"
- **THEN** o gráfico mostra os próximos 24 meses tracejados, com o "guardar por mês" somado ao aportado

### Requirement: Caixinhas em cards
Cada caixinha ativa SHALL aparecer num card com:
- o ícone, o nome, o saldo bruto e como rende ("100% do CDI", "1,1% a.m.", "Não rende");
- a barra da meta (`app-progress`, com `role="progressbar"`), com "chega em mmm/aaaa", o aviso de que não chega ou "Meta atingida";
- "Resgate a partir de dd/mm/aaaa", quando houver trava;
- as ações Guardar e Resgatar, mais um menu com Atualizar saldo, Detalhes, Editar, Encerrar e Excluir.

Com a meta atingida e um plano definido, o card MUST oferecer "Parar de guardar", que zera o plano.

#### Scenario: Caixinha sem meta e com trava
- **WHEN** a caixinha "CDB 2028" não tem meta e só pode ser resgatada a partir de 2028-03-15
- **THEN** o card mostra "Sem meta", "Resgate a partir de 15/03/2028" e o líquido estimado nessa data, sem o botão Resgatar

### Requirement: Detalhes da caixinha
Os detalhes SHALL mostrar:
- as movimentações (inicial, aportes e resgates, com os impostos retidos), com editar e excluir;
- as âncoras, com "Já considerado no saldo de dd/mm" nas movimentações cobertas por uma âncora;
- uma tabela "Imposto se resgatar hoje" por faixa (faixa, rendimento, alíquota, imposto).

#### Scenario: Imposto por faixa
- **WHEN** a pessoa abre os detalhes de uma caixinha com lotes de 400 e de 90 dias
- **THEN** a tabela mostra uma linha de 17,5% e outra de 22,5%, cada uma com o rendimento e o imposto

### Requirement: Formulário simples
O cadastro SHALL ser uma tela só, em seções, com linguagem simples:
- nome e ícone;
- tipo;
- "Quanto você já tem guardado aqui?" e "Desde quando?";
- "Rende quanto?";
- "Mais opções", recolhível: meta, guardar por mês, trava de resgate e imposto.

O formulário MUST NOT usar termos de corretora (P&L, posição, preço médio).

#### Scenario: Cadastro mínimo
- **WHEN** a pessoa preenche só nome, tipo e quanto já tem, com a data de hoje
- **THEN** a caixinha é criada com as sugestões do tipo e sem meta nem plano

### Requirement: Encerradas e estado vazio
As caixinhas encerradas SHALL ficar numa seção "Encerradas" recolhível, com a ação Reabrir. Sem nenhuma caixinha, a tela MUST mostrar um `EmptyState` com o convite "Crie sua primeira caixinha".

#### Scenario: Primeira visita
- **WHEN** a carteira não tem caixinhas
- **THEN** a tela mostra o estado vazio com o botão "+ Nova caixinha", sem gráfico nem cards de resumo

### Requirement: Layout, tema e acessibilidade
A tela SHALL usar só classes `ff-*`, tokens e classes de layout de `app.css`, sem cores literais nem paleta por caixinha.
- A distribuição entre caixinhas, se aparecer, MUST ser uma lista com percentual, e não uma rosca colorida.
- A tela MUST funcionar em 1440 px, 900 px e 390 px, nos temas claro e escuro, sem rolagem horizontal.
- Os botões só com ícone MUST ter rótulo acessível ("Guardar em Reserva", "Mais ações de Reserva").

#### Scenario: Celular
- **WHEN** a tela é aberta com 390 px de largura
- **THEN** os cards de resumo e as caixinhas ficam em uma coluna e nada causa rolagem horizontal

