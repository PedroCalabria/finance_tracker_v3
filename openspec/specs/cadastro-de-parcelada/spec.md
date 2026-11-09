# cadastro-de-parcelada

## Purpose

Datas das parcelas: data única da 1ª parcela fora do crédito, derivação das demais e edição da data de uma parcela (ADR-0004).
## Requirements
### Requirement: Parcelada fora do crédito tem uma única data
O cadastro de parcelada fora do crédito SHALL ter um só campo de data, obrigatório. Na despesa ele se chama "Data p/ pagamento da 1ª parcela"; na entrada, "Data do recebimento da 1ª parcela". Esse campo SHALL NOT vir acompanhado de outra "Data". A API SHALL recebê-lo em `date`, e o servidor SHALL gravá-lo como `entry_date` e como data p/ pagamento da 1ª parcela. O servidor SHALL ignorar `dueDate` nesse caso. A parcela k SHALL ter data p/ pagamento no mesmo dia, k−1 meses depois (dia 31 → último dia do mês), e cair no mês dessa data.

#### Scenario: Três parcelas a partir de 31 de janeiro
- **WHEN** a pessoa cadastra uma despesa de R$ 300,00 em 3 parcelas no boleto com data p/ pagamento da 1ª parcela em 2027-01-31
- **THEN** as parcelas vencem em 2027-01-31, 2027-02-28 e 2027-03-31, de R$ 100,00 cada, e `entry_date` é 2027-01-31

#### Scenario: Entrada parcelada
- **WHEN** a pessoa cadastra uma entrada em 2 parcelas com data do recebimento da 1ª parcela em 2026-11-05
- **THEN** as parcelas são esperadas em 2026-11-05 e 2026-12-05, cada uma no seu mês

#### Scenario: Data ausente
- **WHEN** o cadastro de parcelada fora do crédito chega sem `date`
- **THEN** o servidor responde 400 `validation` no campo `date`

### Requirement: Parcelada no crédito não muda
No crédito, a parcelada SHALL continuar com "Data da compra", que define a fatura da 1ª parcela (ADR-0005). As demais parcelas vão para as faturas seguintes.

#### Scenario: Compra parcelada no cartão
- **WHEN** a pessoa cadastra uma compra em 3 parcelas no crédito com data da compra 2026-11-12, num cartão que fecha no dia 10
- **THEN** a 1ª parcela vai para a fatura definida pela regra compra × fechamento e as outras para as duas faturas seguintes, como hoje

### Requirement: Edição da data de uma parcela
Na edição de uma parcelada fora do crédito, o formulário SHALL mostrar "Data p/ pagamento desta parcela", com a data da parcela aberta. Mudar essa data SHALL ser estrutural: a data recuada até a 1ª posição da sequência vira a data da 1ª parcela e a `entry_date`, e todas as parcelas são recriadas. As parcelas pagas SHALL ser preservadas pelo número, com seus pagamentos, e passar a vencer na data nova (capability `edicao-estrutural`). Se a parcela aberta não tinha data (cadastro antigo) e a pessoa deixar o campo vazio, a edição SHALL ser tratada como mudança simples, sem recriar os meses.

#### Scenario: Mudar a data da 3ª parcela
- **WHEN** uma parcelada de 5 parcelas sem pagamento tem a 3ª vencendo em 2027-01-10 e a pessoa muda essa data para 2027-01-20
- **THEN** a 1ª parcela passa a vencer em 2026-11-20, as demais seguem o dia 20, e `entry_date` vira 2026-11-20

#### Scenario: Mudar a data com a 1ª parcela paga
- **WHEN** uma parcelada de 3 parcelas tem a 1ª paga e a pessoa muda a data da 2ª parcela de 2026-12-10 para 2026-12-15
- **THEN** a 1ª parcela continua paga com o mesmo pagamento e passa a vencer em 2026-11-15, e as demais seguem o dia 15

#### Scenario: Parcelada antiga sem data, editando a descrição
- **WHEN** uma parcelada cadastrada antes desta mudança não tem data p/ pagamento, tem uma parcela paga, e a pessoa muda só a descrição
- **THEN** a descrição é salva, os pagamentos continuam e nenhum mês é recriado

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

