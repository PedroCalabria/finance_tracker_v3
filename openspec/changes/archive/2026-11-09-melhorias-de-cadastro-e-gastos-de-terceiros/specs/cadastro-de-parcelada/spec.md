## ADDED Requirements

### Requirement: Parcelas de meses anteriores entram pagas
No cadastro de parcelada, a pergunta "Já foi pago?" SHALL ser substituída por:
- na despesa: "As parcelas de meses anteriores já foram pagas?";
- na entrada: "As parcelas de meses anteriores já foram recebidas?".

A pergunta tem "Sim" como padrão e SHALL aparecer só quando a 1ª parcela cai antes do mês atual. Na parcelada, a API SHALL receber `pastInstallmentsPaid` e ignorar `alreadyPaid`.

Com `pastInstallmentsPaid: true`:
- **Fora do crédito:** cada parcela de competência anterior ao mês atual SHALL receber um pagamento do valor previsto, na sua data p/ pagamento, e ficar paga. A parcela do mês atual e as seguintes SHALL ficar em aberto, mesmo se já venceram.
- **No crédito:** cada fatura de mês anterior ao atual que recebeu uma parcela SHALL ser paga se estiver aberta, sem pagamentos e sem itens de outros lançamentos. O pagamento tem valor real = valor pago = total da fatura e data = vencimento da fatura. Faturas que já tinham outros itens ou pagamentos SHALL NOT mudar.

Tudo SHALL acontecer na mesma transação do cadastro. A única e a recorrente SHALL continuar com "Já foi pago?" como hoje.

#### Scenario: Compra antiga no boleto
- **WHEN** em 2026-11-08 a pessoa cadastra uma despesa de R$ 500,00 em 5 parcelas no boleto, com a 1ª em 2026-08-10, e deixa "Sim"
- **THEN** as parcelas de agosto, setembro e outubro ficam pagas em 2026-08-10, 2026-09-10 e 2026-10-10; a de novembro e a de dezembro ficam em aberto

#### Scenario: Parcela do mês atual já vencida
- **WHEN** em 2026-11-08 a pessoa cadastra uma parcelada com a 1ª parcela em 2026-10-05, e deixa "Sim"
- **THEN** a parcela de outubro fica paga e a de novembro, que vence em 2026-11-05, fica em aberto e aparece como pendente

#### Scenario: Resposta "Não"
- **WHEN** a pessoa responde "Não" no mesmo cadastro
- **THEN** nenhuma parcela é paga e as de meses anteriores aparecem como atrasadas no mês atual

#### Scenario: Compra nova
- **WHEN** a 1ª parcela cai no mês atual ou depois
- **THEN** a pergunta não aparece e nenhuma parcela é paga no cadastro

#### Scenario: Compra antiga no crédito
- **WHEN** em 2026-11-08 a pessoa cadastra uma compra de 6 parcelas no crédito cuja 1ª parcela vai para a fatura de 2026-08, as faturas de agosto a outubro desse cartão não têm outros itens, e ela deixa "Sim"
- **THEN** as faturas de agosto, setembro e outubro ficam pagas pelo total, cada uma na data de vencimento, e nenhuma aparece como "Fatura atrasada"

#### Scenario: Fatura passada com outros itens
- **WHEN** no mesmo cadastro a fatura de setembro já tinha outra compra em aberto
- **THEN** a fatura de setembro não é paga e continua com as duas compras; as de agosto e outubro são pagas

### Requirement: Parcelada abre no Crédito
No cadastro de despesa, escolher "Parcelada" SHALL mudar o método para "Crédito" se as duas condições valerem:
- a pessoa ainda não mexeu no método;
- existe ao menos um cartão ativo.

Com um só cartão, ele SHALL vir escolhido. Voltar para "Única" ou "Todo mês" sem ter mexido no método SHALL restaurar "Pix". Depois que a pessoa escolhe um método, a forma SHALL NOT mudá-lo. Na edição e nas entradas nada SHALL mudar.

#### Scenario: Parcelada com um cartão
- **WHEN** a pessoa tem um só cartão, abre "Adicionar despesa" e escolhe "Parcelada"
- **THEN** o método vira "Crédito", o cartão vem escolhido e aparece a "Data da compra"

#### Scenario: Método escolhido antes
- **WHEN** a pessoa escolhe "Boleto" e depois "Parcelada"
- **THEN** o método continua "Boleto"

#### Scenario: Sem cartão
- **WHEN** a pessoa não tem cartões e escolhe "Parcelada"
- **THEN** o método continua "Pix"

### Requirement: Setas no número de parcelas
O campo "Número de parcelas" SHALL ter duas setas dentro da caixa, à direita, para aumentar e diminuir 1:
- os limites são 2 e 120, e a seta do limite fica desabilitada;
- as setas ↑/↓ do teclado SHALL fazer o mesmo no campo;
- o campo SHALL aceitar digitação só de números;
- os botões SHALL ter os rótulos acessíveis "Aumentar parcelas" e "Diminuir parcelas".

#### Scenario: Aumentar com a seta
- **WHEN** o campo mostra 2 e a pessoa clica na seta de cima três vezes
- **THEN** o campo mostra 5 e o texto de ajuda passa a "5x de cerca de R$ …"

#### Scenario: Limite inferior
- **WHEN** o campo mostra 2
- **THEN** a seta de baixo fica desabilitada e a tecla ↓ não muda o valor
