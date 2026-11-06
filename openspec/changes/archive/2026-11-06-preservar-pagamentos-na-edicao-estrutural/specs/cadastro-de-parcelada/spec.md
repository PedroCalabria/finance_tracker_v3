## MODIFIED Requirements

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
