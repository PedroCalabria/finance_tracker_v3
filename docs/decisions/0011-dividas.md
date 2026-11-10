# 0011 — Gestão de dívidas

**Status:** aceita · 09/11/2026 · código: `packages/shared/src/debts/`, `apps/server/src/domain/debts.ts`, `apps/web/src/pages/DebtsPage.tsx`, `apps/web/src/debts/` · change OpenSpec `gestao-de-dividas`

## Contexto
O app mostra o que entra e o que sai em cada mês, mas não mostra quanto a pessoa deve, quando termina de pagar e qual dívida pagar primeiro. Empréstimos já aparecem como parceladas e o rotativo como "Saldo restante da fatura", sem saldo devedor nem taxa.

## Decisão

### Módulo isolado da tabela do mês
- As dívidas têm tabelas próprias: `debts`, `debt_balance_anchors`, `debt_payments`, `debt_budgets` e `debt_settings`, todas com `wallet_id`.
- Rotas sob `/api/wallets/:walletId` (`/debts`, `/debt-settings`, `/debt-budgets`, `/debt-plan`), com autorização por membro da carteira.
- Nada no módulo lê ou grava lançamentos, ocorrências, pagamentos ou faturas. Quem quiser o mês completo lança a parcela também na tabela do mês.
- Ligar o módulo ao ledger agora exigiria mexer em projeções, `paidTargets` e na edição estrutural.

### Modelo
- **Categoria:** cartão (parcelamento de fatura), cheque especial, empréstimo pessoal, consignado, financiamento de veículo, financiamento imobiliário, pessoa ou outros.
  - A categoria sugere a estrutura (Pessoa → Sem juros, Imobiliário → SAC, Cheque especial → Rotativo, demais → Price) e "aceita amortização" (não no consignado), enquanto a pessoa não muda esses campos.
  - Na categoria Pessoa, o credor é uma Pessoa da carteira.
- **Estrutura**, em vez de "juros simples/compostos" (toda dívida bancária é de juros compostos; o que muda a simulação é a forma de pagar):
  - Price: parcela fixa.
  - SAC: amortização constante = saldo ÷ parcelas restantes; a parcela é amortização + juros.
  - Rotativo / saldo aberto: mínimo fixo ou percentual do saldo.
  - Sem juros: taxa zero e parcela opcional.
  - Campos de outra estrutura são gravados nulos (`normalizeDebtTerms`).
- **Taxa** mensal composta em milionésimos da fração, inteiro de 0 a 500000 (2,99% a.m. = `29900`).
  - O formulário aceita a.a. e converte com (1+a)^(1/12)−1 (`annualToMonthlyPpm`).
  - Pede o CET e, no imobiliário, que se some uma estimativa do índice (TR/IPCA).
- **Contrato** com a forma dos campos de `items`: `installment_cents`, `remaining_installments` (`smallint`) e `due_day`. `contract_as_of` é a data a que ele se refere.
  - Parcelas restantes de hoje = as do contrato − pagamentos do tipo parcela com data posterior a `contract_as_of`.
  - Cadastro, edição do contrato, "Atualizar saldo" com contrato e amortização extra gravam `contract_as_of`.

### Saldo por âncora
- O saldo real do banco (com IOF, seguros, arredondamentos e índices) não é recalculado. A pessoa informa o **saldo numa data** (âncora), com histórico.
- A âncora mais antiga é o saldo inicial (progresso); a mais recente é a vigente.
- Saldo estimado (`estimateBalance`):
  - no mês da âncora, subtrai os pagamentos com data **posterior** a ela;
  - em cada mês seguinte, soma os juros do mês (saldo × taxa, meio para cima) e depois subtrai os pagamentos do mês;
  - nunca fica abaixo de zero.
- Pagamentos com data ≤ a da âncora já estão no saldo informado. A interface avisa ("Já considerado no saldo de dd/mm").
- Âncora na mesma data substitui a anterior. A única âncora não pode ser excluída (409 `last_anchor`).

### Pagamentos
- `debt_payments`, separados de `payments`. Tipo `installment` (parcela ou mínimo) ou `extra`.
- A amortização extra é recusada com 409 `extra_not_allowed` se a dívida não aceita. Dívida quitada ou excluída recusa pagamento com 409 `debt_not_active`.
- Em Price/SAC, a amortização extra exige o efeito, e o cliente mostra o contrato sugerido (`recalcAfterExtra`), editável:
  - **Price, reduzir prazo:** a parcela fica; n = ⌈−ln(1 − iB/P)/ln(1+i)⌉.
  - **Price, reduzir parcela:** n fica; P = Bi/(1 − (1+i)^−n), **arredondada para cima** (para baixo, sobravam centavos para um mês a mais).
  - **SAC, reduzir prazo:** a amortização de antes fica.
  - **SAC, reduzir parcela:** n fica.
- O servidor grava o contrato enviado (sem conferir a fórmula, porque a pessoa pode corrigir com os números do banco). Sem contrato no corpo, grava o sugerido.
- Editar ou excluir um pagamento **não** desfaz o recálculo do contrato. A interface avisa. Guardar o contrato anterior para reverter fica ambíguo com pagamentos e âncoras intercalados.

### Orçamento e estratégia
- **Orçamento mensal:** é o **total** destinado às dívidas, já com parcelas e mínimos. Fica em vigências "a partir de AAAA-MM", que valem até a próxima.
- **Planejado × destinado:** o destinado é calculado como a soma dos pagamentos registrados no mês, em dívidas ativas ou quitadas, sem as excluídas. Não há campo digitado.
- **Estratégia:**
  - Avalanche (padrão): maior taxa, depois menor saldo, depois cadastro.
  - Bola de neve: menor saldo, depois maior taxa, depois cadastro.
  - Minha ordem: `debts.position`.
    - Escolhida pela primeira vez, grava as posições da avalanche (`manual_order_set`).
    - `PUT /debts/order` exige exatamente as ativas.
    - Uma dívida nova ou reaberta entra no fim.

### Simulação (`simulatePlan`, `buildPlan`)
- **Mês atual:** não reaplica juros (o saldo estimado já os tem).
  - Cada dívida paga o obrigatório menos o que já foi registrado no mês depois da âncora.
  - Sobra = orçamento − destinado no mês − obrigatórios restantes.
- **Meses seguintes:** juros → obrigatórios → sobra = orçamento − obrigatórios.
  - A sobra vai em cascata na ordem da estratégia, pulando quem não aceita amortização.
  - A parcela de uma dívida quitada aumenta a sobra (bola de neve).
  - Na simulação, a amortização reduz o prazo.
- **Obrigatório:**
  - Price: a parcela.
  - SAC: amortização + juros.
  - Rotativo: mínimo fixo ou percentual **arredondado para cima**; saldo de até R$ 1,00 é pago inteiro (`revolvingMinimum`). Com arredondamento comum, um saldo de 7 centavos a 8% gerava juros de 1 centavo e mínimo de 1 centavo para sempre.
  - Sem juros: a parcela, se houver.
  - Nunca maior que o saldo.
- **Sem orçamento:** só os obrigatórios. **Limite:** 600 meses. O saldo simulado tem teto para não estourar o inteiro exato.
- **Avisos:** `budget_short`, `not_decreasing`, `no_budget`, `never_paid_off`.
- **Comparação:** avalanche × bola de neve × minha ordem × só o mínimo (só obrigatórios, sem sobra e sem passar parcelas adiante). A timeline vai só para a estratégia escolhida.
- **"E se eu amortizar R$ X?" (`whatIfExtra`):** só a dívida, pelo contrato, no navegador e sem gravar. Compara sem amortizar × reduzir prazo × reduzir parcela. Rotativo e Sem juros têm um só resultado.
- **Amortização extra por mês (`extraByMonth`):** a simulação devolve quanto da sobra foi de fato aplicado em cada mês (índice 0 = mês atual), em cascata e limitado aos saldos. Depois da última quitação, os meses não aparecem (= 0). Os outros campos não mudaram.

### Amortização extra no balanço do mês (ADR-0012)
- O resumo do mês desconta **só a amortização extra** (`debtExtraForMonth`). As parcelas e os mínimos ficam fora, porque já são lançados como despesa na tabela do mês, e descontá-los de novo contaria duas vezes.
  - **Pago:** pagamentos do tipo `extra` com data no mês, de dívidas não excluídas.
  - **Planejado:** null em meses passados. No mês atual, o pago + a sobra que a simulação ainda aplica no mês 0. Nos futuros, `extraByMonth` daquele mês. Sem orçamento, zero.
  - **Previsto:** o pago nos meses passados; `max(planejado, pago)` no atual e nos futuros.
- A sobra vem da simulação, e não de "orçamento − parcelas", porque a simulação já sabe quando cada dívida termina, quanto cabe no saldo, o que foi pago no mês e a bola de neve.
- **Não lance a amortização extra também na tabela do mês:** ela já sai do balanço por aqui. O ⓘ do card avisa.

## Consequências
- **Lançamento em dois lugares:** a parcela vai na tabela do mês e na dívida. A tela aceita isso nesta entrega. A amortização extra vai **só** na dívida (ADR-0012).
- **Vínculo futuro:** pronto no esquema, sem migrar dados: `debts.item_id` e `debt_payments.occurrence_id` nulos. Seu custo real é uma operação nova no ledger, **cancelar as N últimas parcelas** de uma parcelada, quando a amortização reduz o prazo. Hoje "cancelar compra" cancela todas as futuras.
- **Estimativa × saldo real:** a estimativa se afasta do saldo real (juros diários, seguros, índices) até a próxima âncora. Por isso a lista mostra "saldo informado em dd/mm".
- **Passo mensal:** não há juros pró-rata por dia.
- **Fora desta entrega:**
  - aportes pontuais (13º);
  - indexadores reais;
  - multa e mora;
  - teto de 100% de juros do rotativo;
  - lembretes por email;
  - sugestão de portabilidade;
  - arrastar para reordenar.
