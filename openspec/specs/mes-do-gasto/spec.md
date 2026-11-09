# mes-do-gasto Specification

## Purpose
Mês do gasto de cada ocorrência (no crédito, o da compra; a fatura continua pelo vencimento): regra, gravação, backfill, tabela, recorrentes e período das compras no bloco de faturas (ADR-0004, ADR-0005).
## Requirements
### Requirement: Mês do gasto de cada ocorrência
Toda ocorrência SHALL ter um mês do gasto (`charge_month`), o mês em que o gasto aconteceu. `OccurrenceRow` SHALL trazer `chargeMonth`.
- **Fora do crédito:** igual ao mês da ocorrência (`competence_month`), inclusive quando esse mês muda numa edição.
- **Crédito, compra única:** o mês da data da compra.
- **Crédito, parcela k:** o mês da compra + (k − 1).
- **Crédito, recorrente:** o mês da cobrança.
- **Parcelas importadas da fatura como "PARC n/m":** a 1ª parcela importada fica no mês da compra original + (n − 1), e as seguintes mês a mês.
- **"Ajuste da fatura" e "Saldo restante da fatura":** o mês de referência da fatura.

No crédito, o `competence_month` SHALL continuar sendo o mês da fatura. Faturas, atrasos, lembretes, importação, "mover de fatura", exclusão de recorrente e edição estrutural SHALL continuar usando o `competence_month`. "Mover de fatura" SHALL NOT mudar o mês do gasto. O cálculo do mês do gasto da única e da parcelada SHALL ser uma regra pura em `packages/shared`.

#### Scenario: Compra no cartão que vence no começo do mês
- **WHEN** a pessoa compra R$ 300,00 no crédito em 2026-11-10, num cartão que fecha no dia 25 e vence no dia 1
- **THEN** a ocorrência tem mês do gasto 2026-11 e fica na fatura de dez/2026 (`competence_month` 2026-12)

#### Scenario: Compra depois do fechamento
- **WHEN** a compra no mesmo cartão é em 2026-11-27
- **THEN** o mês do gasto é 2026-11 e a fatura é a de jan/2027

#### Scenario: Parcelada no crédito
- **WHEN** a pessoa compra R$ 300,00 em 3 parcelas no crédito em 2026-11-10, no mesmo cartão
- **THEN** as parcelas têm mês do gasto 2026-11, 2026-12 e 2027-01, e ficam nas faturas de dez/2026, jan/2027 e fev/2027

#### Scenario: Parcela antiga importada da fatura
- **WHEN** a importação da fatura de dez/2026 cria "PARC 05/10" de uma compra de 2026-07-15
- **THEN** a 1ª parcela importada tem mês do gasto 2026-11, e as seguintes 2026-12, 2027-01 e assim por diante

#### Scenario: Mover de fatura
- **WHEN** a pessoa move uma compra de 2026-11-10 da fatura de dez/2026 para a de jan/2027
- **THEN** a ocorrência passa para a fatura de jan/2027 e continua com mês do gasto 2026-11

### Requirement: Tabela e navegação pelo mês do gasto
A tabela do mês SHALL listar as ocorrências cujo mês do gasto é o mês exibido. No mês atual, também SHALL entrar, como hoje, as ocorrências atrasadas fora do crédito de meses anteriores. Na linha no crédito, o selo da fatura ("Fatura em aberto · dez") e a data de vencimento da fatura SHALL continuar. A navegação SHALL ir do primeiro ao último mês com dados, considerando o mês do gasto e o mês da fatura, até pelo menos 6 meses à frente.

#### Scenario: Compra aparece no mês em que foi feita
- **WHEN** a pessoa abre novembro de 2026 depois de comprar R$ 300,00 no crédito em 2026-11-10, num cartão que vence no dia 1
- **THEN** a compra aparece na tabela de novembro, com o selo "Fatura em aberto · dez" e a data 01/12/2026, e não aparece na tabela de dezembro

#### Scenario: Atrasado fora do crédito
- **WHEN** uma conta no boleto de outubro está em aberto e a pessoa abre novembro (mês atual)
- **THEN** a conta aparece em novembro como "Atrasado (out)", como hoje

### Requirement: Recorrentes no crédito pelo mês da cobrança
A ocorrência de uma recorrente no crédito SHALL ser gravada quando a cobrança chega (mês do gasto até o mês atual), mesmo que a fatura dela seja de um mês futuro. Os meses de cobrança futuros SHALL aparecer como previstos no mês do gasto deles. O id da projeção SHALL continuar `p_<itemId>_<mês da fatura>`. O detalhe do lançamento SHALL mostrar os meses do gasto até o mês atual e o próximo previsto.

#### Scenario: Assinatura cobrada no fim do mês
- **WHEN** em 2026-11-03 a pessoa cadastra uma assinatura recorrente no crédito com mês de início 2026-11 e dia da cobrança 28, num cartão que fecha no dia 25 e vence no dia 1
- **THEN** a cobrança de novembro é gravada e aparece em novembro na fatura de jan/2027, e a de dezembro aparece em dezembro como prevista

#### Scenario: Excluir só a cobrança deste mês
- **WHEN** a pessoa exclui com "Só este mês" a cobrança de novembro dessa assinatura
- **THEN** a cobrança de novembro fica cancelada e sai do total da fatura de jan/2027, e as outras continuam

### Requirement: Período das compras no bloco de faturas
O bloco "Faturas do mês" SHALL continuar mostrando as faturas que vencem no mês (e as atrasadas, no mês atual). Cada fatura SHALL mostrar o período das compras dela, do fechamento da fatura anterior até a véspera do seu fechamento. `InvoiceRow` SHALL trazer `purchasesFrom` e `purchasesTo`.

#### Scenario: Fatura de dezembro
- **WHEN** a fatura de dez/2026 de um cartão que fecha no dia 25 e vence no dia 1 aparece em dezembro
- **THEN** ela mostra "compras de 25/10 a 24/11"

### Requirement: Backfill do mês do gasto
A migração SHALL preencher o mês do gasto dos lançamentos existentes:
- **Fora do crédito e itens de sistema:** o mês da ocorrência.
- **Crédito, única:** o mês da data da compra.
- **Crédito, parcela k:** o mês da compra + (k − 1).
- **Única ou parcela fora do intervalo possível:** se o mês calculado ficar mais de 2 meses antes do mês da fatura, ou depois dele, vale o mês anterior ao da fatura. Isso cobre a parcela antiga importada (inclusive a última, "PARC n/n", gravada como única com a data da compra original) e a compra movida.
- **Crédito, recorrente:** o mês do fechamento da fatura, se o dia da cobrança cai antes do fechamento naquele mês; senão, o mês anterior a ele.

Depois do backfill, a coluna SHALL ser obrigatória.

#### Scenario: Compra antiga já gravada
- **WHEN** existe uma compra única no crédito de 2026-10-28 gravada antes desta mudança, na fatura de dez/2026
- **THEN** depois da migração ela tem mês do gasto 2026-10 e aparece na tabela de outubro

