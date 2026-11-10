## Why

Hoje o app mostra o que entra e o que sai em cada mês, mas não responde a quem tem dívidas: **quanto devo, quando termino de pagar e qual dívida pagar primeiro**. Empréstimos e financiamentos já aparecem como parceladas, mas sem saldo devedor nem taxa. Sem isso, não dá para ver o efeito dos juros nem decidir para onde vai o dinheiro que sobra no mês.

## What Changes

- **Tela "Dívidas"** (`/dividas`, item novo no menu principal), por carteira. Nesta entrega o módulo é **isolado da tabela do mês**: parcelas e amortizações continuam sendo lançadas lá também, e o saldo da dívida é mantido no próprio módulo.
- **Cadastro de dívidas:**
  - nome, categoria e credor (texto livre ou uma Pessoa cadastrada);
  - estrutura: Price, SAC, Rotativo/saldo aberto ou Sem juros;
  - taxa mensal com juros compostos (aceita a.a. e converte);
  - contrato (parcela, parcelas restantes, dia) em Price/SAC, ou pagamento mínimo no Rotativo;
  - "aceita amortização extra".
  - A categoria sugere a estrutura e os padrões. Escolher Rotativo com a categoria Cartão mostra um aviso de que o rotativo vira parcelamento na fatura seguinte.
- **Saldo por âncora:** "saldo em dd/mm/aaaa", com histórico. O saldo estimado sai da última âncora, dos juros mês a mês e dos pagamentos registrados depois dela. A primeira âncora é o ponto de partida do progresso.
- **Pagamentos da dívida** (parcela ou amortização extra), com edição e exclusão. Em Price/SAC, a amortização extra pede "reduzir prazo" (padrão) ou "reduzir parcela", recalcula o contrato e deixa a pessoa corrigir com os números do banco.
- **Orçamento mensal para dívidas:** é o total, incluindo parcelas e mínimos, e tem histórico ("a partir de AAAA-MM"). A tela compara, mês a mês, o **planejado** com o **destinado** (a soma dos pagamentos registrados no mês).
- **Estratégia de prioridade:** Avalanche (padrão), Bola de neve ou Minha ordem (reordenada à mão com ↑↓).
- **Simulação mês a mês:**
  - paga os obrigatórios de todas as dívidas;
  - manda a sobra para a primeira dívida da ordem que aceita amortização;
  - quando uma dívida termina, a parcela dela vai para as seguintes (bola de neve).
  - Resultado: a previsão de quitação de cada dívida e de todas, os juros futuros e uma timeline.
  - Avisos: orçamento insuficiente, dívida que não diminui e "não quita em 50 anos".
- **Comparação de estratégias:** avalanche × bola de neve × minha ordem × só o mínimo, com data e juros totais ("sua ordem custa R$ X a mais").
- **"E se eu amortizar R$ X?":** compara reduzir prazo e reduzir parcela, com a economia de juros e os meses a menos.
- **Seção "Quitadas"**, com o histórico preservado.
- **Preparado para o vínculo futuro com a tabela do mês:**
  - tabela própria de pagamentos;
  - campos do contrato com a mesma forma de `items`;
  - saldo que não depende do ledger.
  - O vínculo em si fica fora desta entrega.

## Capabilities

### New Capabilities
- `cadastro-de-dividas`: cadastro, edição, quitação e exclusão de dívidas (categoria, credor, estrutura, taxa, contrato, mínimo, amortização), saldo por âncora com histórico e saldo estimado.
- `pagamentos-de-dividas`: registro, edição e exclusão de pagamentos (parcela e amortização extra), com o recálculo do contrato ao reduzir prazo ou parcela.
- `orcamento-de-dividas`: orçamento mensal com histórico por mês e a comparação entre planejado e destinado.
- `plano-de-quitacao`: estratégia de prioridade (avalanche, bola de neve, minha ordem), simulação mês a mês, previsão de quitação, timeline, comparação de estratégias e simulação de amortização.
- `tela-de-dividas`: a tela `/dividas` (resumo, orçamento, lista, timeline, comparação, quitadas), o item no menu e as regras de layout e acessibilidade.

### Modified Capabilities
(nenhuma: o módulo é isolado e não muda requisitos existentes)

## Impact

- **Banco:** tabelas novas, todas com `wallet_id`:
  - `debts`;
  - `debt_balance_anchors`;
  - `debt_payments`;
  - `debt_budgets`;
  - configuração da estratégia da carteira.
  - Migração `0004` gerada com `npm run db:generate`.
- **Compartilhado** (`packages/shared/src/debts/`):
  - matemática pura: juros, Price, SAC, conversão de taxa, saldo estimado, recálculo na amortização;
  - simulação e comparação de estratégias;
  - testes unitários;
  - contratos zod e tipos da API.
- **Servidor:**
  - `apps/server/src/domain/debts.ts`;
  - rotas em `/api/wallets/:walletId/debts` (e orçamento e estratégia sob a carteira);
  - códigos `AppError` novos;
  - testes de integração em `apps/server/test/debts.test.ts`.
- **Interface:**
  - `pages/DebtsPage` e componentes da dívida (formulário, pagamento, saldo, simulação, timeline em SVG próprio, sem biblioteca de gráficos nova);
  - rota `/dividas` e item no menu (`AppShell`);
  - consultas no TanStack Query com chaves por carteira.
- **Docs:** ADR novo `docs/decisions/0011-dividas.md`, ADR-0009 (rota e tela) e `docs/PROGRESS.md`.
