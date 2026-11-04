# 0009 — Interface

**Status:** aceita · 03/11/2026 · código: `apps/web/src`

## Decisão
- **Design system no código:** `packages/design-system/tokens.json` (fonte) e `components.css` (classes `ff-`) são cópias do artifact "Finanças da Família — Design System". `npm run tokens` gera `apps/web/src/styles/tokens.css` (temas claro/escuro + "igual ao aparelho"). `app.css` só complementa o layout usando tokens. **Ao mudar o design system no artifact, copiar os dois arquivos de novo.**
- **Mudança feita no repositório que deve voltar ao artifact:** `content-max` passou de 1280px para **1440px**, para a tabela de 10 colunas caber inteira em telas largas.
- **Dados:** TanStack Query com chaves por carteira e mês; qualquer mutação invalida ocorrências, resumo, faturas, meses e item (`invalidateFinance`). O cliente HTTP renova a sessão uma única vez quando recebe `token_expired` e repete a chamada; sem sessão, vai para `/entrar` lembrando de onde veio.
- **Estado na URL:** `?mes=2026-11&aba=entradas` — funciona com o link do email e com o botão voltar.
- **Rotas em português:** `/entrar`, `/cadastro`, `/verificar-email`, `/esqueci-senha`, `/redefinir-senha`, `/`, `/categorias`, `/contas`, `/configuracoes`.
- **Tabela responsiva (legibilidade):**
  - O botão de **expandir fica na primeira coluna**, sempre visível (no esboço estava no fim; com 10 colunas ele ficava escondido atrás da rolagem horizontal).
  - O **selo de status fica embaixo do nome do serviço**; a coluna "Data do pagamento" mostra só a ação ("Marcar como pago") ou a data paga com lápis e desfazer. No crédito, mostra o status da fatura.
  - Em contêiner com menos de 1280px (notebooks), **Método aparece embaixo do Banco** e **Observação embaixo do Serviço**; em telas largas as 10 colunas aparecem separadas.
  - Abaixo de **1024px** a tabela vira **lista de cards** (Serviço, Valor, Parcela, Data p/ pagamento + selo e ação). Abaixo de 768px, menu vira gaveta, "+ Adicionar" vira botão flutuante e modais sobem da base da tela.
- **Formulários:** datas com `<input type="date">` nativo (calendário do próprio aparelho); valores com campo próprio que aceita "1.234,56"; rótulo sempre visível; "(opcional)" nos opcionais.
- **Um formulário para cadastrar e editar:** `ItemFormModal` serve aos dois; ao clicar numa linha ele abre preenchido, com status, pagamentos e ações (encerrar, cancelar parcelas, mover de fatura, excluir). Quando a mudança vai recriar os meses, um aviso diz isso antes de salvar (e diz por que não dá, se já houver pagamento). Linhas criadas pela fatura só editam a observação.
- **Cadastro rápido nos seletores:** "+ Nova categoria" e "+ Nova conta"/"+ Novo cartão" no fim das listas do lançamento; a conta é criada ao salvar e passa a valer em Contas e cartões. Fora do crédito só aparecem contas; se a pessoa só tem cartões, o campo explica.
- **Seletor de mês:** "Voltar para o mês atual" fica **à esquerda** do seletor, para o seletor não mudar de lugar quando o atalho aparece.
- **Acessibilidade:** foco preso nos modais (Esc fecha, foco volta a quem abriu), `aria-current` no menu, `aria-sort` nos cabeçalhos, `aria-expanded` no expandir, selos com texto, contraste AA nos dois temas.
- **Tema:** escolha salva no navegador (`ff-theme`), aplicada antes de pintar a tela.

## Verificado
Roteiro no navegador (Playwright) em 1440px, 1920px, 900px e iPhone 13, claro e escuro: cadastro → confirmação → login → lançamentos → pagamento parcial → cadastro no crédito com aviso da fatura → fatura com ajuste e saldo transferido → entradas → mês futuro. Sem rolagem horizontal na página em nenhum tamanho.
