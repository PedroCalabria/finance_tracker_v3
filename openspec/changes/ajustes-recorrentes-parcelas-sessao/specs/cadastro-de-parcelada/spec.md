## ADDED Requirements

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
Na edição de uma parcelada fora do crédito, o formulário SHALL mostrar "Data p/ pagamento desta parcela", com a data da parcela aberta. Mudar essa data SHALL ser estrutural. A data recuada até a 1ª posição da sequência vira a data da 1ª parcela e a `entry_date`, e todas as parcelas são recriadas. A mudança SHALL ser recusada com 409 se houver pagamento. Se a parcela aberta não tinha data (cadastro antigo) e a pessoa deixar o campo vazio, a edição SHALL ser tratada como mudança simples, sem recriar os meses.

#### Scenario: Mudar a data da 3ª parcela
- **WHEN** uma parcelada de 5 parcelas sem pagamento tem a 3ª vencendo em 2027-01-10 e a pessoa muda essa data para 2027-01-20
- **THEN** a 1ª parcela passa a vencer em 2026-11-20, as demais seguem o dia 20, e `entry_date` vira 2026-11-20

#### Scenario: Parcelada antiga sem data, editando a descrição
- **WHEN** uma parcelada cadastrada antes desta mudança não tem data p/ pagamento, tem uma parcela paga, e a pessoa muda só a descrição
- **THEN** a descrição é salva, os pagamentos continuam e nenhum mês é recriado
