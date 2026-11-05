# leitura-de-extratos-e-faturas

## Purpose

Ler extrato de conta e fatura de cartão a partir de arquivo (PDF do Banco do Brasil e OFX), localmente e só em memória, com detecção da origem, linhas normalizadas, conferência de integridade e privacidade (ADR-0010).

## Requirements

### Requirement: Envio e validação do arquivo
A rota `POST /api/wallets/:walletId/imports/preview` SHALL aceitar um único arquivo de até 10 MB, autorizado por membro da carteira. O tipo SHALL ser validado pelo conteúdo: PDF por `file-type`, e OFX pelo cabeçalho `OFXHEADER` ou pela marca `<OFX>` no início do texto. Qualquer outro conteúdo SHALL ser recusado com 400 `import_unsupported_file`. O arquivo SHALL ser processado só em memória e SHALL NOT ser gravado em disco, no storage de comprovantes nem no banco.

#### Scenario: Arquivo de outro tipo
- **WHEN** a pessoa envia uma imagem JPEG renomeada para `extrato.pdf`
- **THEN** a API responde 400 `import_unsupported_file` com "Envie o extrato ou a fatura em PDF, ou um arquivo OFX."

#### Scenario: Arquivo grande demais
- **WHEN** a pessoa envia um PDF de 12 MB
- **THEN** a API responde 413 com "O arquivo passa de 10 MB."

#### Scenario: Nada fica guardado
- **WHEN** uma prévia termina, com sucesso ou com erro
- **THEN** não há cópia do arquivo no storage, no disco nem no banco

### Requirement: Extração local de texto com limites
O texto do PDF SHALL ser extraído no servidor, com a posição (x, y) e a página de cada trecho, por uma biblioteca JavaScript pura com `eval` desligado. A extração SHALL rodar fora da thread principal, com limite de tempo de 20 s e limite de memória. Ao passar do limite, a API SHALL responder 422 `import_timeout`. Nenhum dado do arquivo SHALL ser enviado para fora do servidor.

#### Scenario: PDF que demora demais
- **WHEN** a extração de um PDF passa de 20 s
- **THEN** a thread é encerrada e a API responde 422 `import_timeout` com "Não conseguimos ler este arquivo a tempo. Tente de novo ou use o OFX."

### Requirement: PDF protegido por senha
Quando o PDF exigir senha, a API SHALL responder 422 `pdf_password_required`, e a tela SHALL pedir a senha e reenviar o arquivo com ela. Senha errada SHALL responder 422 `pdf_password_incorrect`. A senha SHALL ser usada só em memória e SHALL NOT aparecer em logs, mensagens de erro nem no banco.

#### Scenario: Pedir a senha
- **WHEN** a pessoa envia uma fatura protegida por senha sem informar a senha
- **THEN** a API responde 422 `pdf_password_required` e a tela mostra o campo "Senha do PDF"

#### Scenario: Senha errada
- **WHEN** a pessoa informa uma senha errada
- **THEN** a API responde 422 `pdf_password_incorrect` com "Senha incorreta." e nada é registrado com a senha

### Requirement: Detecção da origem pelo conteúdo
O sistema SHALL detectar a origem (banco e tipo de documento) pelo conteúdo, consultando um catálogo de leitores. Cada leitor SHALL declarar como reconhecer o documento e como lê-lo. Na primeira entrega, o catálogo SHALL ter `bb-extrato-pdf`, `bb-fatura-pdf` e `ofx`. Um documento que nenhum leitor reconhece SHALL ser recusado com 422 `import_unknown_source`, e acrescentar um leitor SHALL NOT exigir mudança no casamento, na conciliação nem na gravação.

#### Scenario: Extrato do BB
- **WHEN** o PDF tem o título "Extrato de Conta Corrente" e o cabeçalho de colunas "Dia | Lote | Documento | Histórico | Valor"
- **THEN** a origem detectada é `bb-extrato-pdf` (Banco do Brasil, extrato de conta)

#### Scenario: Fatura de outro banco
- **WHEN** a pessoa envia a fatura em PDF de um banco ainda sem leitor
- **THEN** a API responde 422 `import_unknown_source` com "Ainda não sabemos ler este documento. Por enquanto: extrato e fatura do Banco do Brasil em PDF, ou OFX."

### Requirement: Linhas normalizadas
Todo leitor SHALL produzir linhas com:
- data (`YYYY-MM-DD`);
- valor em centavos inteiros, positivo;
- sentido (`credit` ou `debit`);
- descrição;
- documento (opcional);
- dica de tipo, com estes valores: `pix`, `debit_card`, `boleto`, `transfer`, `fee`, `salary`, `invoice_payment`, `financing`, `investment_sweep`, `purchase`, `installment`, `refund`, `invoice_previous_balance`, `other`;
- para parcelas, os números "xx/yy".

O documento SHALL trazer também um cabeçalho com período, identificador da conta ou do cartão e, na fatura, vencimento, fechamento e total. Valores SHALL ser lidos sem ponto flutuante. Linhas de saldo e blocos informativos SHALL ser descartados.

#### Scenario: Valor do extrato BB
- **WHEN** a coluna Valor traz "1.234,56 (-)"
- **THEN** a linha tem 123456 centavos e sentido `debit`

#### Scenario: Histórico em duas linhas
- **WHEN** um lançamento tem "Pix - Enviado" acima da linha principal e "05/10 12:36 FULANO DE TAL" abaixo dela
- **THEN** a linha tem descrição "Pix - Enviado · FULANO DE TAL", dica `pix` e o documento da coluna Documento

#### Scenario: Linhas descartadas
- **WHEN** o extrato tem "Saldo Anterior", "Saldo do dia", "S A L D O" e o bloco "Informações Adicionais"
- **THEN** nenhuma dessas aparece como linha a conciliar

#### Scenario: Data da fatura sem ano
- **WHEN** a fatura fechada em 26/01/2027 traz a compra "20/12" e a parcela "21/03 … PARC 11/12"
- **THEN** as datas são 2026-12-20 e 2026-03-21

#### Scenario: OFX
- **WHEN** o OFX traz `<TRNAMT>-123.45` com `<DTPOSTED>20261005120000[-3:BRT]` e `<FITID>ABC1`
- **THEN** a linha tem 12345 centavos, sentido `debit`, data 2026-10-05 e documento "ABC1"

### Requirement: Conferência de integridade do leitor
Quando o documento traz saldos ou total, o leitor SHALL conferir as linhas contra eles:
- no extrato BB, o saldo anterior mais os movimentos de cada dia bate com o "Saldo do dia";
- na fatura, a soma dos lançamentos bate com o total.

Se não bater, a prévia SHALL avisar "Algumas linhas podem não ter sido lidas corretamente", com a diferença, sem impedir a conciliação.

#### Scenario: Fatura que fecha
- **WHEN** a soma das compras, encargos e créditos da fatura é igual ao "Total da Fatura"
- **THEN** a prévia não mostra aviso de leitura

#### Scenario: Linha perdida
- **WHEN** uma linha do extrato não foi lida e o "Saldo do dia" não bate
- **THEN** a prévia mostra o aviso com o dia e a diferença

### Requirement: Privacidade das descrições e dos logs
Antes de qualquer gravação, CPF e CNPJ nas descrições (com ou sem pontuação, e sequências de 11 ou 14 dígitos) SHALL ser mascarados, mantendo só os 2 últimos dígitos (ex.: "•••••••••61"). O resto da descrição SHALL ser guardado como veio do banco. Os logs da importação SHALL conter só origem, quantidade de linhas e duração, sem descrições, valores, nomes, senha nem identificadores de conta.

#### Scenario: Pix recebido com CPF
- **WHEN** a linha traz "Pix - Recebido · 14/10 09:15 12345678901 FULANA"
- **THEN** a descrição guardada é "Pix - Recebido · •••••••••01 FULANA"

### Requirement: Fixtures anonimizadas
Os testes dos leitores SHALL usar fixtures de texto posicionado geradas a partir de PDFs reais, com nomes, CPFs, CNPJs, documentos, agência, conta e valores trocados, e com saldos e totais recalculados para a conferência continuar valendo. PDFs e textos reais SHALL ficar fora do git.

#### Scenario: Repositório sem dados reais
- **WHEN** alguém procura no repositório nomes, documentos ou valores dos PDFs de exemplo
- **THEN** não encontra: os PDFs ficam em `docs/bank-docs-examples/` (ignorada pelo git) e as fixtures só têm dados fictícios
