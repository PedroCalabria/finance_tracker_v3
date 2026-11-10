# 0009 — Interface

**Status:** aceita · 03/11/2026 · revisada em 08/11/2026 · código: `apps/web/src`

## Decisão
- **Design system no código:** `packages/design-system/tokens.json` (fonte) e `components.css` (classes `ff-`) são cópias do artifact "Finanças da Família — Design System". `npm run tokens` gera `apps/web/src/styles/tokens.css` (temas claro/escuro + "igual ao aparelho"). `app.css` só complementa o layout usando tokens. **Ao mudar o design system no artifact, copiar os dois arquivos de novo.**
- **Mudança feita no repositório que deve voltar ao artifact:** `content-max` passou de 1280px para **1440px**, para a tabela de 10 colunas caber inteira em telas largas.
- **Acréscimos que devem voltar ao artifact:** `StepperInput` (número com setas empilhadas dentro da caixa, `app-stepper`), porque o design system não tem esse campo e o `type="number"` não mostra as setas no Safari do iPhone; e `PersonSelect` (seletor de responsável com "Eu" e "+ Nova pessoa").
- **Dados:** TanStack Query com chaves por carteira e mês; qualquer mutação invalida ocorrências, resumo, faturas, meses e item (`invalidateFinance`). O cliente HTTP (`lib/api.ts`), em **qualquer** 401 fora de `/api/auth/` (o cookie de acesso vence junto com o JWT e o navegador o apaga), renova a sessão uma única vez e repete a chamada uma vez, mesmo se a renovação falhar, porque outra aba pode já ter renovado; com `refresh_superseded`, espera 500 ms antes. A renovação é compartilhada entre chamadas simultâneas e serializada entre abas com Web Locks (ADR-0003). Só se a repetição também for 401 vai para `/entrar` lembrando de onde veio.
- **Estado na URL:** `?mes=2026-11&aba=entradas` — funciona com o link do email e com o botão voltar.
- **Rotas em português:** `/entrar`, `/cadastro`, `/verificar-email`, `/esqueci-senha`, `/redefinir-senha`, `/`, `/categorias`, `/contas`, `/configuracoes`, `/dividas`.
- **Tabela responsiva (legibilidade):**
  - O botão de **expandir fica na primeira coluna**, sempre visível (no esboço estava no fim; com 10 colunas ele ficava escondido atrás da rolagem horizontal).
  - O **selo de status fica embaixo do nome do serviço**; a coluna "Data do pagamento" mostra só a ação ("Marcar como pago") ou a data paga com lápis e desfazer. No crédito, mostra o status da fatura.
  - Coluna **Responsável** depois de Categoria (nome da pessoa ou "Eu", ordenável): são 11 colunas.
  - Em contêiner com menos de 1280px (notebooks), **Método aparece embaixo do Banco**, **Responsável embaixo da Categoria** e **Observação embaixo do Serviço**; em telas largas as colunas aparecem separadas. Nos cards do celular, o responsável aparece no kicker só quando não é "Eu".
  - Abaixo de **1024px** a tabela vira **lista de cards** (Serviço, Valor, Parcela, Data p/ pagamento + selo e ação). Abaixo de 768px, menu vira gaveta, "+ Adicionar" vira botão flutuante e modais sobem da base da tela.
- **Formulários:** datas com `<input type="date">` nativo (calendário do próprio aparelho); **mês com `MonthInput`** (duas listas `ff-select`, mês e ano, em grupo com rótulo), porque `<input type="month">` não funciona bem no Safari; dia do mês com `DayInput` (só números); valores com campo próprio que aceita "1.234,56"; rótulo sempre visível; "(opcional)" nos opcionais.
- **Datas do lançamento por forma (ADR-0004):** a recorrente tem "Mês de início" + "Dia para o pagamento" (opcional; "Sem dia, não há lembrete por email"), "Dia do recebimento" ou "Dia da cobrança" (obrigatórios), sem "Data" e sem "Vencimento"; a parcelada fora do crédito tem um só campo, "Data p/ pagamento da 1ª parcela" ("Data do recebimento da 1ª parcela" na entrada; "… desta parcela" na edição); no crédito, "Data da compra".
- **Um formulário para cadastrar e editar:** `ItemFormModal` serve aos dois; ao clicar numa linha ele abre preenchido, com status, pagamentos e ações (cancelar parcelas, mover de fatura, excluir). Quando a mudança vai recriar os meses, um aviso diz isso antes de salvar (e diz por que não dá, se já houver pagamento). Linhas criadas pela fatura só editam a observação.
- **Excluir recorrente:** `DeleteRecurringDialog` pergunta o alcance com três opções (rádios em `fieldset`, classe `app-choice`): "Só este mês", "Este e os próximos" e "Toda a recorrência", cada uma com uma frase do que acontece; nenhuma vem marcada e "Excluir" fica desabilitado até escolher; "Toda a recorrência" avisa que os meses pagos também somem. Erros do servidor ficam no diálogo. Substitui o antigo "Encerrar a partir deste mês". Nas **linhas previstas**, a ação "Excluir" também aparece (as outras ações continuam escondidas).
- **Importar (ADR-0010):** item "Importar" no menu principal (`/importar`).
  - **Passos:** arquivo (arrastar ou escolher; senha do PDF quando pedida), destino pré-selecionado e conciliação agrupada por sugestão, com totais (a importar, ignoradas, já conciliadas).
  - **Cada linha:** controle de ação e alvo, perguntas ("Só este mês"/"Daqui em diante", "Quitado com desconto"/"Pagamento parcial") e, ao criar, descrição, categoria e método editáveis.
  - **Na fatura:** resumo do total do banco × itens do app e "Usar as datas do banco".
  - **Confirmar:** fica desabilitado até responder as perguntas.
  - **Layout:** a partir de 1024px é tabela com layout fixo e quebra de linha; abaixo disso, cards.
  - **Na memória:** arquivo, senha e prévia nunca vão para o `localStorage`.
- **Responsável no formulário:** na entrada e na edição, o seletor "Responsável" (padrão "Eu"). No cadastro de despesa, o checkbox **"Gasto de outra pessoa"** mostra o seletor sem "Eu", obrigatório, e cria a entrada de reembolso; com ele, o dia da recorrente fora do crédito vira obrigatório. A edição mostra o vínculo ("Reembolso: …" / "Reembolso de …"). Excluir a despesa inteira (inclusive "Toda a recorrência") oferece **"Excluir também o reembolso"**, marcado.
- **Parcelada:** no cadastro de despesa, escolher "Parcelada" muda o método para **Crédito** enquanto a pessoa não escolheu o método e há cartão; voltar para outra forma restaura Pix. O nº de parcelas usa `StepperInput` (2 a 120). "Já foi pago?" vira "As parcelas de meses anteriores já foram pagas?" (padrão Sim), só quando há parcela antes do mês atual.
- **Cards do mês:** o valor em destaque é o **previsto** (balanço, entradas e gastos); o realizado vai na linha de baixo ("Na conta até agora", "recebido · a receber", "pago · a pagar"). Gastos e balanço previsto são pelo **mês do gasto** (ADR-0004); "Na conta até agora" é o caixa.
- **Mês do gasto na tabela:** a compra no crédito aparece no mês em que foi feita, com o selo da fatura ("Fatura em aberto · dez") e a data de vencimento dela; a subgrid da recorrente no crédito mostra o mês da cobrança. O bloco de faturas mostra "Compras de dd/mm a dd/mm". No cadastro no crédito, o aviso diz os dois meses: "Conta como gasto de nov/2026. Vai para a fatura de dez/2026, que vence em 01/12/2026."
- **Dívidas (ADR-0011):** item "Dívidas" no menu principal, depois de "Importar" (`/dividas`, ícone `trend`).
  - **Tela:** cards de resumo (total devedor, quitação de todas, juros futuros, orçamento), avisos do plano, lista de dívidas em cards na ordem da estratégia (seletor Avalanche/Bola de neve/Minha ordem; ↑↓ só em "Minha ordem", com rótulos "Subir/Descer <nome>"), timeline, comparação de estratégias, planejado × destinado e "Quitadas" recolhível.
  - **Abaixo de 1024px:** as tabelas viram cards. **Abaixo de 768px:** "+ Nova dívida" vira botão flutuante.
  - **Timeline:** SVG próprio, sem biblioteca. Uma faixa por dívida, com rótulo direto, área do saldo em `--primary-soft` e contorno `--primary`: nenhuma cor distingue dívidas, porque o design system não tem paleta de séries. Os textos (mês de quitação, eixo) ficam em HTML para não distorcer, e os das pontas crescem para dentro. `role="img"` com descrição e lista em texto ao lado.
  - **"E se eu amortizar?":** tabela de cenários e um botão "Registrar …" por cenário, que abre o registro de pagamento preenchido.
  - **Acréscimos que devem voltar ao artifact:** `app-progress` (barra de progresso com `role="progressbar"`), `app-timeline`; e `th` no corpo das tabelas (`.ff-table tbody th`) com a aparência de célula, não a do cabeçalho.
- **Investimentos (ADR-0012):** item "Investimentos" no menu principal, depois de "Dívidas" (`/investimentos`, ícone `piggy`).
  - **Tela:**
    - cabeçalho com o CDI ("CDI: 14,9% a.a. · atualizado em dd/mm", ou "Informar CDI") e "+ Nova caixinha";
    - aviso `cdi_missing`;
    - quatro cards (Total guardado com o líquido, Rendeu até hoje com o IR estimado, Guardar por mês, Este mês);
    - gráfico "Evolução";
    - caixinhas em cards (3 colunas; 2 abaixo de 1280px; 1 abaixo de 768px);
    - "Encerradas" recolhível, com Reabrir.
    - Sem caixinhas, `EmptyState`. Abaixo de 768px, "+ Nova caixinha" vira botão flutuante.
  - **Card da caixinha:**
    - ícone, tipo, nome (abre os detalhes), bruto, como rende, quanto rendeu;
    - meta com `app-progress` e "chega em mmm/aaaa", o aviso de que não chega (com o plano sugerido) ou "Meta atingida" + "Parar de guardar";
    - líquido hoje, guardar por mês, rende por mês, líquido na data de resgate;
    - selo "Resgate a partir de dd/mm/aaaa";
    - Guardar e Resgatar. Resgatar some antes da trava e com saldo zero.
    - As demais ações ficam num menu `details`/`summary` nativo (`app-menu`), com rótulo "Mais ações de <nome>".
  - **Gráfico "Evolução":** SVG próprio com duas séries, o saldo (área `--primary-soft`, contorno `--primary`) e o aportado (linha `--ink-muted`). Duas séries dispensam a paleta de séries que o design system não tem, e não há rosca por caixinha.
    - Marca "hoje"; projeção tracejada.
    - `Segmented` 6 meses / 1 ano / Projeção 2 anos.
    - Eixo, valor máximo e legenda em HTML; `role="img"` com descrição e resumo em texto.
  - **Formulário:** uma tela em seções, com linguagem simples.
    - Nome; ícone (`app-iconpick`, grupo de rádio com rótulos); tipo; "Quanto você já tem guardado aqui?" e "Desde quando?"; "Rende quanto?" (% do CDI / taxa fixa ao mês ou ao ano / não rende).
    - "Mais opções", recolhível: meta, mês da meta, guardar por mês, trava, imposto.
    - O tipo sugere rendimento e imposto até a pessoa mexer neles.
    - Sem CDI na carteira, pede o CDI junto.
  - **Resgatar:** prévia "Imposto estimado R$ X · você recebe cerca de R$ Y", calculada no navegador com as funções puras e o histórico da caixinha. "Impostos retidos" vem preenchido e é editável.
  - **Ícones novos** no traço do design system: `piggy`, `shield`, `home`, `plane`, `car`, `gift`, `heart`, `book`, `star`.
- **Card "Balanço do mês" com destino (ADR-0012):** quando o mês tem caixinhas com plano, aportes, resgates ou amortização extra, o card mostra o valor com "livre no mês" e a conta em linhas: Entradas, − Gastos, − Guardar em caixinhas, + Resgatado das caixinhas, − Amortizar dívidas. Linhas zeradas ficam ocultas, e "Na conta até agora" fica embaixo.
  - As linhas de caixinhas e dívidas têm um botão ⓘ de abrir e fechar (`aria-expanded`, `aria-controls`). Ele mostra a explicação abaixo da linha, com link para a tela. É um botão e não um tooltip porque no celular não há "passar o mouse" e o design system não tem tooltip.
  - Sem destino no mês, o card é o de antes.
  - **Acréscimos que devem voltar ao artifact:** os ícones novos, `app-menu`, `app-iconpick`, `app-invchart` e as linhas do balanço (`app-balance`).
- **Categorias e pessoas:** a tela de Categorias tem três opções: Despesas, Entradas e **Pessoas**.
- **Cadastro rápido nos seletores:** "+ Nova categoria" e "+ Nova conta"/"+ Novo cartão" no fim das listas do lançamento; a conta é criada ao salvar e passa a valer em Contas e cartões. Fora do crédito só aparecem contas; se a pessoa só tem cartões, o campo explica.
- **Seletor de mês:** "Voltar para o mês atual" fica **à esquerda** do seletor, para o seletor não mudar de lugar quando o atalho aparece.
- **Acessibilidade:** foco preso nos modais (Esc fecha, foco volta a quem abriu), `aria-current` no menu, `aria-sort` nos cabeçalhos, `aria-expanded` no expandir, selos com texto, contraste AA nos dois temas.
- **Tema:** escolha salva no navegador (`ff-theme`), aplicada antes de pintar a tela.

## Verificado
Roteiro no navegador (Playwright) em 1440px, 1920px, 900px e iPhone 13, claro e escuro: cadastro → confirmação → login → lançamentos → pagamento parcial → cadastro no crédito com aviso da fatura → fatura com ajuste e saldo transferido → entradas → mês futuro. Sem rolagem horizontal na página em nenhum tamanho.
