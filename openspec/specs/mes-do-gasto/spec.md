# mes-do-gasto Specification

## Purpose
Mês do gasto de cada ocorrência (no crédito, o do período de compras da fatura; a fatura continua pelo vencimento): regra, gravação, backfill, tabela, recorrentes e período das compras no bloco de faturas (ADR-0004, ADR-0005).
## Requirements
### Requirement: Mês do gasto de cada ocorrência
Toda ocorrência SHALL ter um mês do gasto (`charge_month`). `OccurrenceRow` SHALL trazer `chargeMonth`.
- **Fora do crédito:** igual ao mês da ocorrência (`competence_month`), inclusive quando esse mês muda numa edição.
- **Crédito (única, parcela, recorrente e "PARC n/m" importada):** o mês do período de compras da fatura da ocorrência, ou seja, o mês em que cai a maior parte do período que vai do fechamento da fatura anterior até a véspera do fechamento dela. Em caso de empate, vale o primeiro mês. São consideradas as datas ajustadas das faturas.
- **"Ajuste da fatura" e "Saldo restante da fatura":** o mês de referência da fatura.

No crédito, o `competence_month` SHALL continuar sendo o mês da fatura. Faturas, atrasos, lembretes, importação, "mover de fatura", exclusão de recorrente e edição estrutural SHALL continuar usando o `competence_month`. "Mover de fatura" SHALL levar o mês do gasto da fatura de destino. Ajustar o fechamento de uma fatura SHALL recalcular o mês do gasto dos itens dela e da seguinte. O cálculo SHALL ser uma regra pura em `packages/shared` (`invoiceChargeMonth`). A prévia da fatura no cadastro (`/invoice-preview`) SHALL trazer o `chargeMonth`.

#### Scenario: Compra no cartão que vence no começo do mês
- **WHEN** a pessoa compra R$ 300,00 no crédito em 2026-11-10, num cartão que fecha no dia 25 e vence no dia 1
- **THEN** a ocorrência tem mês do gasto 2026-11 e fica na fatura de dez/2026 (`competence_month` 2026-12), que tem as compras de 25/10 a 24/11

#### Scenario: Compra depois do fechamento
- **WHEN** a compra no mesmo cartão é em 2026-11-27
- **THEN** a fatura é a de jan/2027 (compras de 25/11 a 24/12) e o mês do gasto é 2026-12

#### Scenario: Cartão que fecha no fim do mês
- **WHEN** a pessoa compra no crédito em 2026-10-30, num cartão que fecha no dia 28 e vence no dia 5
- **THEN** a compra fica na fatura de dez/2026 (compras de 28/10 a 27/11) e o mês do gasto é 2026-11

#### Scenario: Cartão que fecha no começo do mês
- **WHEN** a pessoa compra no crédito em 2026-11-01, num cartão que fecha no dia 3 e vence no dia 10
- **THEN** a compra fica na fatura de nov/2026 (compras de 03/10 a 02/11) e o mês do gasto é 2026-10

#### Scenario: Parcelada no crédito
- **WHEN** a pessoa compra R$ 300,00 em 3 parcelas no crédito em 2026-11-10, num cartão que fecha no dia 25 e vence no dia 1
- **THEN** as parcelas têm mês do gasto 2026-11, 2026-12 e 2027-01, e ficam nas faturas de dez/2026, jan/2027 e fev/2027

#### Scenario: Parcela antiga importada da fatura
- **WHEN** a importação da fatura de dez/2026 do mesmo cartão cria "PARC 05/10" de uma compra de 2026-07-15
- **THEN** a 1ª parcela importada tem mês do gasto 2026-11 (o da fatura de dez), e as seguintes 2026-12, 2027-01 e assim por diante

#### Scenario: Mover de fatura
- **WHEN** a pessoa move uma compra de 2026-11-10 da fatura de dez/2026 para a de jan/2027, no mesmo cartão
- **THEN** a ocorrência passa para a fatura de jan/2027 e para o mês do gasto 2026-12

### Requirement: Tabela e navegação pelo mês do gasto
A tabela do mês SHALL listar as ocorrências cujo mês do gasto é o mês exibido. No mês atual, também SHALL entrar, como hoje, as ocorrências atrasadas fora do crédito de meses anteriores. Na linha no crédito, o selo da fatura ("Fatura em aberto · dez") e a data de vencimento da fatura SHALL continuar. A navegação SHALL ir do primeiro ao último mês com dados, considerando o mês do gasto e o mês da fatura, até pelo menos 6 meses à frente.

#### Scenario: Compra aparece no mês em que foi feita
- **WHEN** a pessoa abre novembro de 2026 depois de comprar R$ 300,00 no crédito em 2026-11-10, num cartão que fecha no dia 25 e vence no dia 1
- **THEN** a compra aparece na tabela de novembro, com o selo "Fatura em aberto · dez" e a data 01/12/2026, e não aparece na tabela de dezembro

#### Scenario: Atrasado fora do crédito
- **WHEN** uma conta no boleto de outubro está em aberto e a pessoa abre novembro (mês atual)
- **THEN** a conta aparece em novembro como "Atrasado (out)", como hoje

### Requirement: Recorrentes no crédito pelo mês da cobrança
A ocorrência de uma recorrente no crédito SHALL ser gravada quando a cobrança chega (mês da cobrança na regra ou mês do gasto até o mês atual), mesmo que a fatura dela seja de um mês futuro. As cobranças futuras SHALL aparecer como previstas no mês do gasto delas. O id da projeção SHALL continuar `p_<itemId>_<mês da fatura>`. O detalhe do lançamento SHALL mostrar as cobranças gravadas com mês do gasto até o mês seguinte ao atual e a próxima prevista depois delas.

#### Scenario: Assinatura cobrada no fim do mês
- **WHEN** em 2026-11-03 a pessoa cadastra uma assinatura recorrente no crédito com mês de início 2026-11 e dia da cobrança 28, num cartão que fecha no dia 25 e vence no dia 1
- **THEN** a cobrança de 28/11 é gravada, fica na fatura de jan/2027 (compras de 25/11 a 24/12) e aparece em dezembro; a de 28/12 aparece em janeiro como prevista

#### Scenario: Excluir só a cobrança deste mês
- **WHEN** a pessoa exclui com "Só este mês" a cobrança de 28/11 dessa assinatura
- **THEN** a cobrança fica cancelada e sai do total da fatura de jan/2027, e as outras continuam

### Requirement: Período das compras no bloco de faturas
O bloco "Faturas do mês" SHALL continuar mostrando as faturas que vencem no mês (e as atrasadas, no mês atual). Cada fatura SHALL mostrar o período das compras dela, do fechamento da fatura anterior até a véspera do seu fechamento. `InvoiceRow` SHALL trazer `purchasesFrom` e `purchasesTo`.

#### Scenario: Fatura de dezembro
- **WHEN** a fatura de dez/2026 de um cartão que fecha no dia 25 e vence no dia 1 aparece em dezembro
- **THEN** ela mostra "compras de 25/10 a 24/11"

### Requirement: Backfill do mês do gasto
A migração `0006` SHALL recalcular o mês do gasto das ocorrências no crédito que não são de sistema pela regra da fatura (o mês com a maior parte do período de compras), usando o fechamento gravado da fatura anterior ou, sem ela, o fechamento padrão do cartão.

A migração `0003` preencheu o mês do gasto dos lançamentos que existiam antes dela:
- **Fora do crédito e itens de sistema:** o mês da ocorrência.
- **Crédito, única:** o mês da data da compra.
- **Crédito, parcela k:** o mês da compra + (k − 1).
- **Única ou parcela fora do intervalo possível:** se o mês calculado ficar mais de 2 meses antes do mês da fatura, ou depois dele, vale o mês anterior ao da fatura. Isso cobre a parcela antiga importada (inclusive a última, "PARC n/n", gravada como única com a data da compra original) e a compra movida.
- **Crédito, recorrente:** o mês do fechamento da fatura, se o dia da cobrança cai antes do fechamento naquele mês; senão, o mês anterior a ele.

Depois do backfill, a coluna SHALL ser obrigatória.

#### Scenario: Compra antiga já gravada
- **WHEN** existe uma compra única no crédito de 2026-10-28 gravada antes da `0003`, na fatura de dez/2026 de um cartão que fecha no dia 25 e vence no dia 1
- **THEN** depois da `0003` ela tem mês do gasto 2026-10, e depois da `0006` tem 2026-11 (compras de 25/10 a 24/11)

#### Scenario: Compra depois do fechamento já gravada
- **WHEN** existe uma compra única no crédito de 2026-10-30 com mês do gasto 2026-10, na fatura de dez/2026 de um cartão que fecha no dia 28 e vence no dia 5
- **THEN** depois da `0006` ela tem mês do gasto 2026-11 e aparece na tabela de novembro

