# 0009 — Interface

**Status:** aceita · 03/11/2026 · revisada em 04/11/2026 · código: `apps/web/src`

## Decisão
- **Design system no código:** `packages/design-system/tokens.json` (fonte) e `components.css` (classes `ff-`) são cópias do artifact "Finanças da Família — Design System". `npm run tokens` gera `apps/web/src/styles/tokens.css` (temas claro/escuro + "igual ao aparelho"). `app.css` só complementa o layout usando tokens. **Ao mudar o design system no artifact, copiar os dois arquivos de novo.**
- **Mudança feita no repositório que deve voltar ao artifact:** `content-max` passou de 1280px para **1440px**, para a tabela de 10 colunas caber inteira em telas largas.
- **Dados:** TanStack Query com chaves por carteira e mês; qualquer mutação invalida ocorrências, resumo, faturas, meses e item (`invalidateFinance`). O cliente HTTP (`lib/api.ts`), em **qualquer** 401 fora de `/api/auth/` (o cookie de acesso vence junto com o JWT e o navegador o apaga), renova a sessão uma única vez e repete a chamada uma vez, mesmo se a renovação falhar, porque outra aba pode já ter renovado; com `refresh_superseded`, espera 500 ms antes. A renovação é compartilhada entre chamadas simultâneas e serializada entre abas com Web Locks (ADR-0003). Só se a repetição também for 401 vai para `/entrar` lembrando de onde veio.
- **Estado na URL:** `?mes=2026-11&aba=entradas` — funciona com o link do email e com o botão voltar.
- **Rotas em português:** `/entrar`, `/cadastro`, `/verificar-email`, `/esqueci-senha`, `/redefinir-senha`, `/`, `/categorias`, `/contas`, `/configuracoes`.
- **Tabela responsiva (legibilidade):**
  - O botão de **expandir fica na primeira coluna**, sempre visível (no esboço estava no fim; com 10 colunas ele ficava escondido atrás da rolagem horizontal).
  - O **selo de status fica embaixo do nome do serviço**; a coluna "Data do pagamento" mostra só a ação ("Marcar como pago") ou a data paga com lápis e desfazer. No crédito, mostra o status da fatura.
  - Em contêiner com menos de 1280px (notebooks), **Método aparece embaixo do Banco** e **Observação embaixo do Serviço**; em telas largas as 10 colunas aparecem separadas.
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
- **Cadastro rápido nos seletores:** "+ Nova categoria" e "+ Nova conta"/"+ Novo cartão" no fim das listas do lançamento; a conta é criada ao salvar e passa a valer em Contas e cartões. Fora do crédito só aparecem contas; se a pessoa só tem cartões, o campo explica.
- **Seletor de mês:** "Voltar para o mês atual" fica **à esquerda** do seletor, para o seletor não mudar de lugar quando o atalho aparece.
- **Acessibilidade:** foco preso nos modais (Esc fecha, foco volta a quem abriu), `aria-current` no menu, `aria-sort` nos cabeçalhos, `aria-expanded` no expandir, selos com texto, contraste AA nos dois temas.
- **Tema:** escolha salva no navegador (`ff-theme`), aplicada antes de pintar a tela.

## Verificado
Roteiro no navegador (Playwright) em 1440px, 1920px, 900px e iPhone 13, claro e escuro: cadastro → confirmação → login → lançamentos → pagamento parcial → cadastro no crédito com aviso da fatura → fatura com ajuste e saldo transferido → entradas → mês futuro. Sem rolagem horizontal na página em nenhum tamanho.
