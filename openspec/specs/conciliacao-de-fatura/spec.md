# conciliacao-de-fatura

## Purpose

Conciliar a fatura do cartão importada com os itens da fatura no app: compras, parcelas, encargos, créditos, datas e valor real (ADR-0010, ADR-0005).

## Requirements

### Requirement: Identificação da fatura
Uma fatura importada SHALL ser associada ao cartão de destino escolhido (só cartões de crédito) e à fatura desse cartão com `reference_month` igual ao mês do vencimento lido no documento. Se a fatura ainda não existir, ela SHALL ser criada (`ensureInvoice`). O destino SHALL ser pré-selecionado pelo final do cartão já usado antes (guardado em hash) ou, sem ele, pelo único cartão do banco detectado.

#### Scenario: Fatura de dezembro
- **WHEN** o PDF da fatura do Ourocard traz vencimento 10/12/2026
- **THEN** a conciliação é feita contra a fatura de dezembro de 2026 do cartão escolhido

#### Scenario: Fatura já paga
- **WHEN** a fatura de destino já está paga ou encerrada
- **THEN** a prévia avisa "Esta fatura já foi paga no app"; só vincular é permitido, e criar itens nela é recusado com 409 `invoice_closed`

### Requirement: Datas da fatura
Quando o fechamento ou o vencimento do documento diferirem dos da fatura no app, a prévia SHALL oferecer "Usar as datas do banco" (marcado por padrão). Confirmar com a opção marcada SHALL ajustar as datas daquele mês da fatura (como no "ajustar" da ADR-0005).

#### Scenario: Fechamento diferente
- **WHEN** o app calculou o fechamento em 28/11 e a fatura do banco diz "Fatura fechada em 29/11"
- **THEN** a prévia mostra a diferença, e ao confirmar a fatura passa a fechar em 29/11

### Requirement: Casamento de compras e parcelas
Cada compra da fatura SHALL ser comparada com as ocorrências da fatura de destino, inclusive as recorrentes previstas para ela. A comparação usa o valor (igual), a data da compra contra a data do item (a até 3 dias; na recorrente, o dia da cobrança) e a semelhança de descrição. Uma linha com "PARC xx/yy" SHALL casar, de preferência, com a parcela de número xx de um item parcelado do cartão com yy parcelas. Confirmar um `match` SHALL só vincular a linha à ocorrência, porque itens no crédito não têm pagamento próprio.

#### Scenario: Compra lançada no app
- **WHEN** o app tem "Mercado" de R$ 250,00 comprado em 12/11 nesse cartão, e a fatura traz "12/11 SUPERMERCADO X · R$ 250,00"
- **THEN** a sugestão é casar com "Mercado"

#### Scenario: Parcela existente
- **WHEN** o app tem "Óculos" em 10 parcelas no cartão, com a parcela 6/10 nesta fatura, e a linha traz "PARC 06/10"
- **THEN** a sugestão é casar com a parcela 6/10 de "Óculos", e diferença de valor aparece como aviso

### Requirement: Criar compra no crédito
Uma compra sem casamento SHALL sugerir criar o item no crédito do cartão de destino, com a data da compra e a primeira (ou única) ocorrência **nesta** fatura, mesmo que a regra compra × fechamento calcule outra:
- **compra à vista:** item único;
- **"PARC xx/yy" com xx = 1:** item parcelado de yy parcelas, com total = valor × yy (a última parcela leva a sobra, se houver);
- **"PARC xx/yy" com xx > 1:** item parcelado só com as parcelas restantes (yy − xx + 1), com a primeira nesta fatura e total = valor × restantes. A observação da primeira ocorrência registra "Parcelas xx a yy de yy (importado da fatura)". As parcelas anteriores não são criadas, porque faturas passadas já estão fechadas.

#### Scenario: Compra parcelada antiga
- **WHEN** a fatura traz "LOJA EXEMPLO PARC 09/10 · R$ 120,00" e não há item correspondente
- **THEN** a sugestão é criar "LOJA EXEMPLO" com 2 parcelas de R$ 120,00 (nesta fatura e na seguinte), com a observação "Parcelas 9 a 10 de 10 (importado da fatura)"

#### Scenario: Compra perto do fechamento
- **WHEN** a compra é de 28/11, a regra do app a mandaria para a fatura seguinte e o banco a lançou nesta
- **THEN** o item criado fica nesta fatura

### Requirement: Encargos, créditos e saldo anterior
- Linhas de encargo da fatura (IOF, juros, tarifas) SHALL sugerir criar despesa única no crédito.
- Créditos e estornos (valor negativo, exceto pagamentos) SHALL aparecer como linhas a decidir, com sugestão `ignore` e a explicação "Entra no ajuste da fatura".
- "SALDO FATURA ANTERIOR" e o pagamento da fatura anterior ("PGTO. …") SHALL ser informativos e não entram na conciliação: o pagamento é conciliado pelo extrato.

#### Scenario: Crédito de juros
- **WHEN** a fatura traz "AJUSTE A CREDITO DE JUROS · R$ -25,00"
- **THEN** a linha aparece em "Créditos e estornos", sugerida como "Entra no ajuste da fatura"

### Requirement: Valor real e ajuste
O total da fatura lido no documento SHALL ser sugerido como valor real. Confirmar SHALL gravar esse valor em `invoices.real_amount_cents` da fatura aberta, sem pagá-la. O "Ajuste da fatura" continua sendo criado no pagamento (ADR-0005), com o valor real gravado vindo preenchido. A prévia SHALL mostrar total do banco, soma dos itens do app depois da confirmação e diferença que irá para o ajuste.

#### Scenario: Diferença vira ajuste
- **WHEN** a fatura do banco soma R$ 1.000,00, os itens do app depois da conciliação somam R$ 990,00 e a pessoa paga a fatura depois
- **THEN** o pagamento vem com valor real R$ 1.000,00 e cria o "Ajuste da fatura" de R$ 10,00

### Requirement: Itens do app sem linha na fatura
A prévia de uma fatura SHALL listar as ocorrências da fatura de destino que não casaram com nenhuma linha, com a ação sugerida "Mover para outra fatura" ou "Excluir" (que leva à tela do lançamento).

#### Scenario: Compra lançada no cartão errado
- **WHEN** o app tem "Farmácia" nesta fatura e o banco não traz linha correspondente
- **THEN** "Farmácia" aparece em "No app, mas não na fatura"
