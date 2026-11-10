# cadastro-de-caixinhas Specification

## Purpose
Cadastro, edição, encerramento, reabertura e exclusão de caixinhas (tipo e sugestões, ícone, rendimento, trava de resgate, imposto, meta, guardar por mês), o valor inicial, o CDI da carteira e o saldo informado (ADR-0012).
## Requirements
### Requirement: Cadastro de caixinha
A pessoa SHALL poder cadastrar uma caixinha na carteira com:
- nome e ícone (uma chave da lista curada `INVESTMENT_ICONS`);
- tipo: Caixinha/CDB/RDB, Tesouro, LCI/LCA, Poupança ou Outro;
- como rende: Prefixado (taxa a.m. ou a.a.), % do CDI ou Não rende;
- quando pode resgatar: a qualquer momento ou só a partir de uma data;
- imposto: tabela regressiva ou isento;
- meta (valor e mês-alvo), opcional;
- guardar por mês, opcional;
- o valor inicial com a data ("quanto você já tem e desde quando").

O cadastro MUST gravar a caixinha e o valor inicial (movimentação `initial`) na mesma transação.

A rota MUST ficar sob `/api/wallets/:walletId` e autorizar por membro da carteira.

#### Scenario: Cadastro de uma caixinha com CDI
- **WHEN** a pessoa cadastra "Reserva" do tipo Caixinha, rendendo 100% do CDI, com R$ 10.000,00 desde 2026-03-10, meta de R$ 20.000,00 e guardar por mês de R$ 500,00
- **THEN** a caixinha é criada ativa, com `cdi_share_bp` = 10000, `fixed_rate_ppm` nulo e uma movimentação `initial` de 1000000 centavos em 2026-03-10

#### Scenario: Pessoa de outra carteira
- **WHEN** alguém que não é membro da carteira tenta cadastrar ou ler uma caixinha dela
- **THEN** a API recusa, como nas demais rotas financeiras

### Requirement: Sugestões pelo tipo
O formulário SHALL preencher como rende, a liquidez e o imposto conforme o tipo, enquanto a pessoa não mudar esses campos:

| Tipo | Rende como | Imposto |
| --- | --- | --- |
| Caixinha/CDB/RDB | 100% do CDI | regressivo |
| Tesouro | 100% do CDI | regressivo |
| LCI/LCA | 95% do CDI | isento |
| Poupança | prefixado 0,5% a.m. | isento |
| Outro | não rende | isento |

Todos começam com resgate a qualquer momento. Depois que a pessoa muda um desses campos, trocar o tipo MUST NOT sobrescrevê-lo.

#### Scenario: Escolher LCI/LCA
- **WHEN** a pessoa escolhe o tipo LCI/LCA num cadastro novo
- **THEN** o formulário mostra "95% do CDI" e "Isento"

#### Scenario: Campo mudado pela pessoa
- **WHEN** a pessoa escolhe Caixinha, muda o imposto para Isento e depois troca o tipo para Tesouro
- **THEN** o imposto continua Isento

### Requirement: Campos coerentes com o rendimento
O servidor SHALL normalizar os campos do rendimento:
- `fixed` exige `fixed_rate_ppm` entre 0 e 100000 e grava `cdi_share_bp` nulo;
- `cdi` exige `cdi_share_bp` entre 1 e 30000 e grava `fixed_rate_ppm` nulo;
- `none` grava os dois nulos.

Uma taxa informada ao ano MUST ser convertida em mensal composta (`annualToMonthlyPpm`).

`goal_month` MUST exigir `goal_cents`. O guardar por mês, quando informado, MUST ser maior que zero. O ícone MUST estar em `INVESTMENT_ICONS`.

#### Scenario: Taxa ao ano
- **WHEN** a pessoa informa prefixado de 12,6825% a.a.
- **THEN** a caixinha grava `fixed_rate_ppm` = 10000 (1% a.m.)

#### Scenario: Ícone fora da lista
- **WHEN** o corpo da requisição traz o ícone "rocket", que não está na lista
- **THEN** a API recusa com erro de validação no campo do ícone

#### Scenario: Mês-alvo sem meta
- **WHEN** a pessoa informa o mês-alvo 2027-12 sem valor de meta
- **THEN** a API recusa com erro de validação

### Requirement: CDI da carteira
A carteira SHALL ter uma configuração de investimentos com o CDI anual estimado, em milionésimos (14,90% a.a. = 149000), e a data da última atualização.

`PUT /investment-settings` MUST gravar a data de hoje como a da atualização.

Quando a pessoa escolhe "% do CDI" e a carteira não tem CDI, o formulário MUST pedir o CDI antes de salvar.

#### Scenario: Atualizar o CDI
- **WHEN** em 2026-11-10 a pessoa informa o CDI de 14,90% a.a.
- **THEN** a configuração fica com `cdi_annual_ppm` = 149000 e `cdi_updated_on` = 2026-11-10, e a tela mostra "CDI: 14,9% a.a. · atualizado em 10/11"

### Requirement: Saldo informado (âncora)
A pessoa SHALL poder informar o saldo da caixinha numa data (âncora), com histórico.
- Âncora na mesma data MUST substituir a anterior.
- A data MUST NOT estar no futuro.
- Movimentações com data menor ou igual à da âncora MUST ser consideradas incluídas nela.
- Âncoras podem ser excluídas.

#### Scenario: Corrigir o saldo
- **WHEN** a estimativa da caixinha em 2026-11-10 é R$ 10.828,56 e a pessoa informa R$ 10.840,00 nessa data
- **THEN** o saldo bruto passa a ser R$ 10.840,00 e o rendimento até hoje aumenta R$ 11,44

### Requirement: Edição, encerramento, reabertura e exclusão
A pessoa SHALL poder:
- **editar** os campos da caixinha;
- **encerrar**: grava, na mesma transação, um resgate do saldo estimado na data, com o imposto estimado (os dois editáveis no modal), e muda o status para encerrada;
- **reabrir**: volta para ativa sem mexer nas movimentações;
- **excluir**: exclusão lógica; a caixinha some da tela e do resumo do mês.

Encerrar antes da data de "resgate a partir de" MUST ser recusado com 409 `locked_until`.

#### Scenario: Encerrar
- **WHEN** a pessoa encerra em 2026-11-10 uma caixinha com saldo estimado de R$ 1.200,00 e imposto estimado de R$ 30,00
- **THEN** é gravado um resgate de 120000 com `tax_cents` = 3000, a caixinha fica encerrada e aparece em "Encerradas"

#### Scenario: Encerrar antes da data
- **WHEN** a caixinha só pode ser resgatada a partir de 2028-03-15 e a pessoa tenta encerrá-la em 2026-11-10
- **THEN** a API recusa com 409 `locked_until` e a mensagem "Só pode resgatar a partir de 15/03/2028"

#### Scenario: Reabrir
- **WHEN** a pessoa reabre uma caixinha encerrada
- **THEN** ela volta para a lista de ativas com o histórico de movimentações intacto

