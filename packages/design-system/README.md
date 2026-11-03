Finanças da Família é o painel em que a família acompanha despesas, entradas, parcelas e faturas do mês. Quem usa tem pouca afinidade com tecnologia: cada tela responde "quanto entrou, quanto saiu e o que falta pagar" sem exigir que a pessoa procure. O uso principal é no computador, e tudo funciona no celular pelo navegador.

## Princípios

- **Legível antes de bonito.** Texto corrido em `body` (16px), nada abaixo de `caption` (13px). Valores em R$ sempre com algarismos tabulares (`ff-num`).
- **Um destaque por tela.** O card de Balanço (`hero`) é o único bloco preenchido. Botão primário: um por card ou modal.
- **Status escrito.** Todo estado vira um selo com ícone e texto (`StatusBadge`). A cor reforça, nunca é o único sinal.
- **Calmo.** Fundo `bg` claro, cards `surface` com borda `border` e sombra quase invisível (`shadow-card`). Sem gradientes, sem ilustrações, sem emoji.

## Conteúdo e tom

- Português do dia a dia, frases curtas, tratamento por "você". Ações no infinitivo: "Marcar como pago", "Pagar fatura", "Adicionar despesa".
- Sem jargão financeiro: "O que já foi pago", não "liquidado"; "a receber", não "provisionado".
- Valores sempre no formato brasileiro: `R$ 1.234,56`. Entradas com `+`, atrasos com `−` ou o selo Atrasado.
- Datas em `dd/mm/aaaa` nas tabelas e `dd/mm` em listas compactas ("Vence 05/11"). Meses por extenso no seletor ("Novembro de 2026") e abreviados entre parênteses nos selos ("Atrasado (out)").
- Mensagens de erro dizem como resolver: "Essa data não existe. Confira o dia."

## Cores

O tema claro vem dos tons de verde-azulado de referência; o escuro usa preto quase puro com o verde-menta como acento.

- Fundo da página `bg`; cards, tabela e barra lateral `surface`; cabeçalho da tabela, hover e subgrid `surface-subtle`.
- Texto `ink` sobre qualquer superfície; texto secundário `ink-muted`, nunca para valores.
- Ação principal `primary` com texto `on-primary`. Links e botões fantasmas `primary-ink`. Item ativo do menu `primary-soft` com `primary-ink`.
- Card de Balanço: fundo `hero`, título e valor `hero-ink`, linha secundária `hero-muted`, divisória `hero-line`.
- Status: Pago `success-bg`/`success-ink`; Pendente `warning-bg`/`warning-ink` (âmbar com texto marrom escuro); Atrasado `danger-bg`/`danger-ink`; Parcial e avisos `info-bg`/`info-ink`; Cancelado e Fatura em aberto `neutral-bg`/`neutral-ink`.
- Valores: entradas em `amount-in`; gastos comuns ficam em `ink`; `amount-out` só para destacar atrasos.
- Bordas de campos e do botão secundário em `border-control` (3:1); `border` é só divisória.
- Todo par texto/fundo listado acima passa de 4,5:1 nos dois temas.

## Tipografia

Uma família, Manrope (Google Fonts, pesos 400–700), carregada por `components/bundle.css`.

- `amount-xl` nos valores dos cards; `amount-lg` no celular e no total de fatura.
- `title` no título da página; `heading` em títulos de card, bloco e modal.
- `body` no texto e nas células; `body-strong` em nomes de serviço e botões; `label` em rótulos e cabeçalhos; `caption` em linhas secundárias.
- Todo número que se compara (valores, datas, parcelas) usa `font-variant-numeric: tabular-nums`.

## Espaço e layout

- Escala de 4px: `space-1` a `space-7`. Padding de card `space-5`; gutter entre cards `space-5`; margem do conteúdo `space-6`.
- Cantos: `radius-md` em botões e campos, `radius-lg` em cards, tabela e modais, `radius-full` em selos e chips.
- Alvos de toque com no mínimo `control-h` (44px); linhas da tabela com `row-h` (56px).

**Computador** (a partir de `breakpoint-md`): barra lateral `SidebarNav` de `sidebar-w` e conteúdo até `content-max`. De cima para baixo: `MonthSelector` e o título do mês; os três `SummaryCard` em uma linha; o bloco de faturas (`InvoiceRow`); `Tabs` com os filtros e o botão "Adicionar"; a `OccurrenceTable`.

**Celular** (abaixo de `breakpoint-md`): `ff-topbar` com menu, nome e avisos; cards empilhados; abas e chips roláveis na horizontal; a tabela vira lista de `OccurrenceCard`; "+ Adicionar" vira `ff-fab`; modais sobem da base da tela.

## Estados e interação

- Foco do teclado: anel sólido de 2px em `focus-ring` com 2px de afastamento, em todo controle.
- Hover de linha e de item de menu: `surface-subtle`. Pressionado em primário: `primary-hover`.
- Desativado: 50% de opacidade e cursor de bloqueio; explique o porquê perto do controle quando não for óbvio.
- Carregando: mantenha o layout e troque o valor por um bloco `surface-subtle` do mesmo tamanho.
- Sem animações além de transições de cor de até 150ms.

## Iconografia

- Ícones de traço no estilo Lucide (lucide.dev): 24×24, traço 1,75, pontas arredondadas, cor `currentColor`. 20px no menu e nos cards, 18px em botões, 14px em selos.
- Ícone sempre acompanhado de texto, exceto em `ff-icon-btn`, que exige `aria-label`.
- Sem logo por enquanto: o nome aparece em texto (`ff-wordmark`). Bancos aparecem por iniciais num bloco `surface-subtle`, nunca com o logo do banco.

## Modo escuro

Mesmos tokens, outro tema. Preto quase puro em `bg`, cards `surface` com borda e sem sombra, acento verde-menta em `primary`. Texto sobre o menta é escuro (`on-primary`), nunca branco.

## Usando este sistema

Carregue `tokens.css` e `components/bundle.css`; os componentes são HTML com classes `ff-`, sem JavaScript próprio. Na aplicação React, cada componente vira um componente que monta essa marcação.
