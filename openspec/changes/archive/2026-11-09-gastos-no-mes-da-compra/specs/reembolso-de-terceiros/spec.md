## MODIFIED Requirements

### Requirement: Datas do reembolso
As datas da entrada de reembolso SHALL seguir a despesa, de modo que o reembolso caia no mesmo mês do gasto (capability `mes-do-gasto`) e o balanço do mês zere para aquele gasto:

| Despesa | Entrada de reembolso |
| --- | --- |
| Única fora do crédito | Data do recebimento = data p/ pagamento da despesa ou, sem ela, a data da despesa |
| Única no crédito | Data do recebimento = data da compra |
| Parcelada fora do crédito | Data do recebimento da 1ª parcela = data da 1ª parcela da despesa |
| Parcelada no crédito | Data do recebimento da 1ª parcela = data da compra; as demais no mesmo dia dos meses seguintes |
| Recorrente fora do crédito | Mesmo mês de início e mesmo dia |
| Recorrente no crédito | Mesmo mês de início; dia do recebimento = dia da cobrança |

#### Scenario: Parcelada no crédito
- **WHEN** a pessoa cadastra uma despesa de R$ 300,00 em 3 parcelas no crédito, com data da compra 2026-11-12, num cartão que fecha no dia 10 e vence no dia 17, marcada como gasto de "João"
- **THEN** as parcelas da despesa têm mês do gasto 2026-11, 2026-12 e 2027-01, e a entrada de reembolso tem 3 parcelas de R$ 100,00 a receber em 2026-11-12, 2026-12-12 e 2027-01-12

#### Scenario: Recorrente no crédito
- **WHEN** a pessoa cadastra uma assinatura recorrente no crédito com mês de início 2026-11 e dia da cobrança 28, num cartão que fecha no dia 25 e vence no dia 5, marcada como gasto de "Ana"
- **THEN** a entrada de reembolso é recorrente, começa em 2026-11 e tem dia do recebimento 28

#### Scenario: Única fora do crédito com data p/ pagamento
- **WHEN** a despesa única no boleto tem data 2026-11-03 e data p/ pagamento 2026-11-20
- **THEN** a entrada de reembolso tem data do recebimento 2026-11-20
