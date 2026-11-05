# conciliacao-de-extrato

## Purpose

Sugerir e gravar a conciliação das linhas de um extrato de conta com os lançamentos do app, sem duplicar em reimportações (ADR-0010, ADR-0004, ADR-0005).

## Requirements

### Requirement: Destino e pré-seleção
A pessoa SHALL escolher a conta de destino de um extrato, que só pode ser conta (não cartão). O sistema SHALL pré-selecionar primeiro a conta já usada antes com a mesma conta de origem (pelo identificador guardado em hash) e, sem ela, a única conta do banco detectado. Trocar o destino SHALL recalcular as sugestões sem reenviar o arquivo.

#### Scenario: Primeira importação do BB
- **WHEN** a pessoa tem uma só conta com banco "Banco do Brasil" e importa o primeiro extrato do BB
- **THEN** essa conta vem selecionada

#### Scenario: Reimportação lembra o destino
- **WHEN** a pessoa já importou extratos daquela agência e conta para "Conta BB Família"
- **THEN** a próxima importação dessa origem já vem com "Conta BB Família"

### Requirement: Sugestão por linha
Cada linha SHALL receber exatamente uma sugestão, que a pessoa pode trocar antes de confirmar:
- `match`: casar com um lançamento existente;
- `create`: criar lançamento novo;
- `invoice_payment`: pagamento de fatura;
- `ignore`: ignorar;
- `already`: já conciliada antes; não muda, só aparece agrupada.

Nada SHALL ser gravado antes de `POST /imports/confirm`.

#### Scenario: Prévia não grava
- **WHEN** a pessoa envia o extrato e fecha a tela sem confirmar
- **THEN** nenhum pagamento, item ou vínculo foi criado

### Requirement: Casamento com ocorrências e projeções
Os candidatos de uma linha SHALL ser as ocorrências e as projeções fora do crédito, do mesmo sentido (débito → despesa, crédito → entrada), com a conta de destino ou sem conta, e com data p/ pagamento a até 7 dias da data da linha (sem data p/ pagamento: no mesmo mês). A pontuação SHALL combinar valor (igual, ou próximo nas recorrentes variáveis), distância de datas e semelhança de descrição. A melhor acima do limiar SHALL virar a sugestão `match`, e as outras SHALL aparecer como alternativas. Projeções SHALL passar por `materializeProjection` antes de qualquer escrita.

#### Scenario: Conta de luz pendente
- **WHEN** existe "Conta de luz" pendente de R$ 210,00 com data p/ pagamento 07/10 e o extrato traz "Pagamento conta luz" de R$ 210,00 em 07/10
- **THEN** a sugestão é casar com "Conta de luz" de outubro

#### Scenario: Mês previsto
- **WHEN** a linha casa com a recorrente "Escola" de um mês ainda previsto (`p_<itemId>_<mês>`) e a pessoa confirma
- **THEN** o mês é gravado por `materializeProjection` e recebe o pagamento

### Requirement: Gravação de um casamento
Confirmar um `match` SHALL registrar o pagamento (`addPayment`) na data da linha e com o valor da linha, seguindo estas regras:
- **recorrente variável:** o valor previsto do mês vira o valor do extrato e o mês fica pago;
- **recorrente fixa com valor maior:** a pessoa escolhe "só este mês" (muda só o previsto deste mês, sem mudar a regra) ou "daqui em diante" (muda a regra, como na edição);
- **valor menor que o restante:** a pessoa escolhe desconto ou parcial (regra `settlement_required`);
- **parcela:** casa com a próxima parcela em aberto do item, e diferença de valor aparece como aviso;
- **ocorrência já paga no app** com pagamento de mesmo valor a até 7 dias: a linha só é vinculada a esse pagamento, sem pagar de novo.

#### Scenario: Água com valor do mês
- **WHEN** "Água" (recorrente variável, previsto R$ 90,00) casa com uma linha de R$ 112,50
- **THEN** outubro fica previsto R$ 112,50, pago R$ 112,50 na data da linha, e novembro começa com R$ 112,50

#### Scenario: Recorrente fixa mais cara, só este mês
- **WHEN** "Internet" (fixa, R$ 120,00) casa com uma linha de R$ 135,00 e a pessoa escolhe "só este mês"
- **THEN** outubro fica previsto e pago R$ 135,00, e a regra continua R$ 120,00

#### Scenario: Valor menor sem escolha
- **WHEN** a linha é menor que o restante e a confirmação chega sem `settlement`
- **THEN** a confirmação inteira é recusada com 400 `settlement_required` apontando a linha, e nada é gravado

#### Scenario: Já pago no app
- **WHEN** "Academia" de outubro já foi marcada como paga no app em 05/10 com R$ 99,00 e o extrato traz R$ 99,00 em 06/10
- **THEN** a sugestão é `match` com o selo "Já pago no app", e confirmar só vincula a linha ao pagamento existente

#### Scenario: Parcela de financiamento
- **WHEN** "Pagamento BB Finan PF" de R$ 850,00 casa com um item parcelado cuja próxima parcela em aberto é a 7/24 de R$ 850,00
- **THEN** a parcela 7/24 é paga na data da linha

### Requirement: Pagamento de fatura no extrato
Uma linha com dica `invoice_payment` SHALL ser sugerida como pagamento da fatura aberta (ou atrasada) de um cartão, com vencimento a até 10 dias da data da linha:
- "Pagto cartão crédito": cartão do mesmo banco do extrato;
- "Pagamento de Boleto" cujo favorecido é um banco (ex.: "BANCO XP S.A"): cartão com esse banco.

Confirmar SHALL chamar `payInvoice` com o valor da linha, a data da linha e o valor real da fatura (o importado da fatura, se houver; senão a soma dos itens, editável na tela). A linha SHALL NOT virar despesa. Se a fatura já tiver um pagamento de mesmo valor e data a até 3 dias, a linha só SHALL ser vinculada a ele.

#### Scenario: Pagamento da fatura do BB
- **WHEN** o extrato do BB traz "Pagto cartão crédito" em 01/10, e o cartão BB tem a fatura de outubro aberta, vencendo em 05/10
- **THEN** a sugestão é pagar essa fatura, e ao confirmar a fatura fica paga (ou parcialmente paga) sem criar despesa

#### Scenario: Boleto de outro cartão
- **WHEN** o extrato traz "Pagamento de Boleto · BANCO XP S.A" e existe um cartão com banco "XP"
- **THEN** a sugestão é pagar a fatura desse cartão; sem cartão do XP, a sugestão é criar despesa no boleto

### Requirement: Linhas com tratamento próprio
O leitor do extrato BB SHALL classificar:
- "BB Rende Fácil" e "Rende Facil" (aplicação e resgate automáticos) como `investment_sweep`, com sugestão `ignore`;
- "Tarifa Pacote de Serviços", "Cobrança de I.O.F." e "Juros Saldo Devedor Conta"/"Cobrança de Juros" como `fee`, com sugestão `create` (despesa única no débito, categoria sugerida "Outros");
- "Pagamento BB Finan PF" como `financing` (casa com item parcelado; sem casamento, sugere criar);
- "Recebimento de Proventos" como `salary`, que casa com entrada recorrente e, sem casamento, sugere criar entrada;
- Pix, compra com cartão (débito) e boleto como `pix`, `debit_card` e `boleto`, com o método correspondente na criação.

#### Scenario: Rende Fácil
- **WHEN** o extrato traz "BB Rende Fácil · Rende Facil" de R$ 1.000,00 (+)
- **THEN** a sugestão é ignorar, com a explicação "Aplicação/resgate automático"

#### Scenario: Tarifa
- **WHEN** o extrato traz "Tarifa Pacote de Serviços" de R$ 30,00 (-) sem lançamento correspondente
- **THEN** a sugestão é criar a despesa "Tarifa Pacote de Serviços" no débito, já paga na data da linha

### Requirement: Criar lançamento a partir da linha
Confirmar um `create` SHALL criar um item único (`createItem`) com:
- tipo pelo sentido;
- método pela dica;
- conta de destino;
- data e data p/ pagamento iguais à data da linha;
- valor da linha;
- categoria escolhida (opcional);
- descrição editável.

O pagamento SHALL ser registrado na data da linha.

#### Scenario: Pix novo
- **WHEN** a pessoa confirma `create` numa linha "Pix - Enviado · LOJA EXEMPLO" de R$ 40,00 em 16/10
- **THEN** existe a despesa única "LOJA EXEMPLO", Pix, R$ 40,00, paga em 16/10, no mês de outubro

### Requirement: Gravação atômica e sem duplicar
A confirmação SHALL gravar tudo numa única transação. Se qualquer linha falhar, nada SHALL ser gravado, e a resposta SHALL dizer qual linha falhou e por quê. Cada linha confirmada, inclusive as ignoradas, SHALL guardar uma impressão digital. Ela é um SHA-256 de carteira + conta de destino + data + valor + sentido + documento + descrição normalizada + ordem entre linhas idênticas no mesmo dia. Uma linha cuja impressão digital já existe SHALL aparecer como `already` e SHALL NOT ser gravada de novo.

#### Scenario: Reimportar período sobreposto
- **WHEN** a pessoa importa o extrato de 01 a 31/10 e depois o de 15/10 a 15/11
- **THEN** as linhas de 15 a 31/10 aparecem como "Já conciliadas" e nenhum pagamento é duplicado

#### Scenario: Duas linhas idênticas no mesmo dia
- **WHEN** o extrato traz dois "Pix - Enviado" iguais de R$ 15,00 no mesmo dia
- **THEN** as duas são conciliadas separadamente (ordem 1 e 2), e reimportar não duplica nenhuma

#### Scenario: Prévia adulterada ou vencida
- **WHEN** a confirmação chega com linhas diferentes das assinadas na prévia, ou depois de 2 h
- **THEN** a API responde 400 `import_preview_invalid` com "Esta prévia expirou. Envie o arquivo de novo." e nada é gravado

### Requirement: Pagamentos sem linha no extrato
A prévia de um extrato SHALL listar os pagamentos registrados no app no período do extrato, em ocorrências fora do crédito com a conta de destino, que não casaram com nenhuma linha (nem nesta importação, nem em importações anteriores).

#### Scenario: Pagamento marcado por engano
- **WHEN** "Mercado" foi marcado como pago em 10/10 com a conta BB, e o extrato de outubro não traz linha correspondente
- **THEN** a seção "No app, mas não no extrato" mostra "Mercado · 10/10 · R$ …"
