# reembolso-de-terceiros Specification

## Purpose
Despesa de outra pessoa gera a entrada de reembolso vinculada: valores, datas, categoria "Gasto de terceiros" e exclusão conjunta (ADR-0004).
## Requirements
### Requirement: Despesa marcada como gasto de outra pessoa
O cadastro de despesa SHALL ter o checkbox "Gasto de outra pessoa", desmarcado por padrão. Marcado, o formulário SHALL mostrar o seletor de pessoa:
- sem a opção "Eu";
- obrigatório, com o erro "Escolha a pessoa." quando vazio.

A API SHALL receber `createReimbursement: true` com `personId`. O servidor SHALL recusar com 400 `validation`:
- `createReimbursement` numa entrada;
- `createReimbursement` sem `personId`;
- numa despesa recorrente fora do crédito, `createReimbursement` sem `day`, com a mensagem "Informe o dia: o reembolso usa o mesmo dia.".

O checkbox SHALL NOT aparecer na edição.

#### Scenario: Pessoa obrigatória
- **WHEN** a pessoa marca "Gasto de outra pessoa" e salva sem escolher ninguém
- **THEN** o formulário mostra "Escolha a pessoa." e nada é gravado

#### Scenario: Recorrente sem dia
- **WHEN** a pessoa cadastra uma despesa recorrente no Pix, sem "Dia para o pagamento", marcada como gasto de outra pessoa
- **THEN** o servidor responde 400 `validation` no campo `day` com "Informe o dia: o reembolso usa o mesmo dia."

### Requirement: Entrada de reembolso criada no cadastro
Ao cadastrar uma despesa com `createReimbursement`, o servidor SHALL criar, na mesma transação, uma entrada com:
- a mesma descrição, o mesmo valor (ou total) e a mesma forma;
- o mesmo nº de parcelas, na parcelada;
- o mesmo "valor varia", na recorrente;
- a mesma pessoa como responsável;
- método Pix;
- a conta da despesa, se ela for fora do crédito (no crédito, sem conta);
- a categoria de entrada "Gasto de terceiros".

A categoria SHALL ser a categoria de entrada ativa com esse nome, sem diferenciar maiúsculas, ou, se não existir, uma nova criada na mesma transação. Se qualquer parte falhar, nem a despesa nem a entrada SHALL ser gravadas. Na parcelada, a entrada SHALL seguir a resposta da despesa para as parcelas de meses anteriores (capability `cadastro-de-parcelada`). O "Já foi pago?" da única e da recorrente SHALL NOT passar para a entrada: ela nasce a receber, porque pagar a despesa não quer dizer que a pessoa já devolveu. O cálculo dos campos da entrada SHALL ser uma regra pura em `packages/shared`.

#### Scenario: Única no Pix
- **WHEN** a pessoa cadastra uma despesa única de R$ 80,00 no Pix, com data 2026-11-03, conta "Nubank", marcada como gasto de "Maria"
- **THEN** são gravadas a despesa e uma entrada única de R$ 80,00 no Pix, conta "Nubank", data e data do recebimento 2026-11-03, categoria "Gasto de terceiros" e responsável "Maria"

#### Scenario: Despesa paga, reembolso a receber
- **WHEN** a pessoa cadastra uma despesa única no Pix, de hoje, com "Já foi pago?" = Sim, marcada como gasto de "Maria"
- **THEN** a despesa nasce paga e a entrada de reembolso nasce a receber

#### Scenario: Categoria criada na primeira vez
- **WHEN** a carteira não tem a categoria de entrada "Gasto de terceiros" e a pessoa cadastra o primeiro gasto de outra pessoa
- **THEN** a categoria de entrada "Gasto de terceiros" é criada e usada no reembolso; no segundo cadastro, a mesma categoria é reaproveitada

#### Scenario: Falha no cadastro
- **WHEN** o cadastro de uma despesa de terceiro é recusado (por exemplo, cartão de outra carteira)
- **THEN** nenhuma despesa, entrada ou categoria é gravada

### Requirement: Datas do reembolso
As datas da entrada de reembolso SHALL seguir a despesa, de modo que o reembolso caia no mesmo mês do gasto (capability `mes-do-gasto`) e o balanço do mês zere para aquele gasto:

| Despesa | Entrada de reembolso |
| --- | --- |
| Única fora do crédito | Data do recebimento = data p/ pagamento da despesa ou, sem ela, a data da despesa |
| Única no crédito | Data do recebimento = dia da compra no mês do gasto da despesa |
| Parcelada fora do crédito | Data do recebimento da 1ª parcela = data da 1ª parcela da despesa |
| Parcelada no crédito | Data do recebimento da 1ª parcela = dia da compra no mês do gasto da 1ª parcela; as demais no mesmo dia dos meses seguintes |
| Recorrente fora do crédito | Mesmo mês de início e mesmo dia |
| Recorrente no crédito | Começa no mês do gasto da 1ª cobrança; dia do recebimento = dia da cobrança |

#### Scenario: Parcelada no crédito
- **WHEN** a pessoa cadastra uma despesa de R$ 300,00 em 3 parcelas no crédito, com data da compra 2026-11-12, num cartão que fecha no dia 10 e vence no dia 17, marcada como gasto de "João"
- **THEN** as parcelas da despesa têm mês do gasto 2026-11, 2026-12 e 2027-01, e a entrada de reembolso tem 3 parcelas de R$ 100,00 a receber em 2026-11-12, 2026-12-12 e 2027-01-12

#### Scenario: Recorrente no crédito
- **WHEN** a pessoa cadastra uma assinatura recorrente no crédito com mês de início 2026-11 e dia da cobrança 28, num cartão que fecha no dia 25 e vence no dia 5, marcada como gasto de "Ana"
- **THEN** a cobrança de 28/11 tem mês do gasto 2026-12 (fatura de jan/2027, compras de 25/11 a 24/12), e a entrada de reembolso é recorrente, começa em 2026-12 e tem dia do recebimento 28

#### Scenario: Única no crédito depois do fechamento
- **WHEN** a pessoa cadastra uma despesa única no crédito com data da compra 2026-10-30, num cartão que fecha no dia 28 e vence no dia 5, marcada como gasto de "Ana"
- **THEN** a despesa tem mês do gasto 2026-11 e a entrada de reembolso tem data do recebimento 2026-11-30

#### Scenario: Única fora do crédito com data p/ pagamento
- **WHEN** a despesa única no boleto tem data 2026-11-03 e data p/ pagamento 2026-11-20
- **THEN** a entrada de reembolso tem data do recebimento 2026-11-20

### Requirement: Vínculo entre despesa e reembolso
A entrada de reembolso SHALL guardar o id da despesa (`reimburses_item_id`). `ItemDetail` SHALL trazer:
- na despesa, `reimbursement: { id, description }` enquanto o reembolso não for excluído;
- na entrada, `reimburses: { id, description }` enquanto a despesa não for excluída.

O formulário de edição SHALL mostrar o vínculo: "Reembolso: <descrição>" na despesa e "Reembolso de <descrição>" na entrada. Editar a despesa SHALL NOT alterar a entrada de reembolso. A entrada SHALL poder ser editada e excluída como qualquer lançamento.

#### Scenario: Editar o valor da despesa
- **WHEN** a pessoa muda o valor de uma despesa que tem reembolso de R$ 80,00 para R$ 90,00
- **THEN** a despesa passa a R$ 90,00, o reembolso continua com R$ 80,00 e o formulário continua mostrando o vínculo

#### Scenario: Excluir só o reembolso
- **WHEN** a pessoa exclui a entrada de reembolso
- **THEN** a despesa continua como estava e deixa de mostrar "Reembolso: …"

### Requirement: Excluir a despesa com o reembolso
Ao excluir uma despesa inteira que tem reembolso, a confirmação SHALL oferecer o checkbox "Excluir também o reembolso", marcado por padrão. Isso vale para "Excluir", e para "Toda a recorrência" na recorrente. Marcado, a interface SHALL chamar `DELETE /items/:id?withReimbursement=1`, e o servidor SHALL fazer a exclusão lógica dos dois na mesma transação. Se a exclusão da despesa for recusada, o reembolso SHALL continuar. Desmarcado, só a despesa SHALL ser excluída. Os demais alcances SHALL NOT mexer no reembolso: "Só este mês", "Este e os próximos" e cancelar as parcelas futuras.

#### Scenario: Excluir com o reembolso
- **WHEN** a pessoa exclui uma despesa que tem reembolso, com "Excluir também o reembolso" marcado
- **THEN** a despesa e a entrada de reembolso somem das telas e dos cards

#### Scenario: Excluir sem o reembolso
- **WHEN** a pessoa desmarca "Excluir também o reembolso" e confirma
- **THEN** só a despesa é excluída; a entrada continua e deixa de mostrar "Reembolso de …"

#### Scenario: Cancelar parcelas não mexe no reembolso
- **WHEN** a pessoa cancela as parcelas futuras de uma despesa parcelada que tem reembolso
- **THEN** as parcelas futuras da despesa são canceladas e as parcelas do reembolso continuam como estavam

