# 0010 — Importação de extratos e faturas

**Status:** aceita · 05/11/2026 · código: `packages/shared/src/imports/`, `apps/server/src/imports/`, `apps/server/src/domain/imports/`, `apps/web/src/pages/ImportPage.tsx`

## Desvio da especificação
A especificação previa, na fase 2, importar extrato **OFX/CSV**. O banco principal da família (Banco do Brasil) entrega o extrato da conta e a fatura do Ourocard em **PDF**, então a primeira entrega lê:
- extrato de conta corrente do BB em PDF;
- fatura Ourocard (BB) em PDF;
- OFX de conta de qualquer banco.

O CSV fica para quando aparecer o primeiro banco que só ofereça CSV. Outros bancos (XP, Nubank…) entram com um leitor novo.

## Decisão

### Leitura
- **Tudo no servidor e só em memória:**
  - o arquivo nunca é gravado (nem storage, nem disco, nem banco);
  - sem IA e sem serviço externo;
  - tipo validado pelo conteúdo (`file-type` para PDF; cabeçalho `OFXHEADER`/`<OFX>` para OFX), com limite de 10 MB;
  - os PDFs reais de exemplo ficam em `docs/bank-docs-examples/`, fora do git e da imagem Docker (`.gitignore` e `.dockerignore`).
- **Extração do PDF** com `unpdf` 1.9.1, que traz o pdf.js 6 empacotado: MIT, sem dependências, sem binário nativo, sem `eval`/`new Function`. Foi escolhido em vez do `pdfjs-dist` direto, cujo build para Node tem `@napi-rs/canvas` (nativo) como dependência opcional e tenta carregá-lo ao iniciar.
  - Roda numa **worker thread** (`pdf-text.worker.mjs`, JavaScript para funcionar igual em desenvolvimento, testes e build), com 20 s, 256 MB, 2 por processo e até 50 páginas.
  - Devolve cada trecho com x, y e página.
  - **PDF com senha:** a tela pede a senha (`pdf_password_required` / `pdf_password_incorrect`), que só vive na requisição e nunca é registrada.
- **Catálogo de leitores puros** (`READERS` em `packages/shared/src/imports`): cada leitor tem `detect(doc)` (pelo conteúdo) e `read(doc)`, que transforma o texto posicionado em linhas normalizadas.
  - Uma linha tem data, valor em centavos, sentido, descrição, documento, dica de tipo, nome e método sugeridos, seção e "PARC xx/yy".
  - Banco novo = arquivo novo + entrada no catálogo; casamento e gravação não mudam.
- **Extrato BB:** o histórico ocupa até três trechos **acima, na mesma altura ou abaixo** da linha com o valor, e texto corrido embaralha as colunas.
  - O leitor acha as colunas pelo cabeçalho e liga cada trecho de histórico à linha principal mais próxima na vertical.
  - Descarta os saldos e os blocos "Informações…".
- **Fatura BB:** datas "dd/mm" sem ano.
  - O ano sai do fechamento: a data fica até ele e perto do mês esperado, que numa "PARC xx/yy" é xx − 1 meses antes.
  - O saldo anterior e o pagamento da fatura anterior são só informativos.
- **Conferência de integridade:** o extrato confere com cada "Saldo do dia" e com "S A L D O"; a fatura confere com "Total da Fatura". Diferença vira aviso na prévia, o primeiro alarme se o banco mudar o layout.
- **Classificação** por tabela de regras: Rende Fácil é ignorado; "Pagto cartão crédito" e "Pagamento de Boleto · BANCO X" são pagamentos de fatura; tarifa, IOF e juros são despesas novas; "BB Finan" é parcela de financiamento; proventos são entrada; Pix, débito e boleto definem o método.
- **Privacidade:** CPF e CNPJ (com ou sem pontuação, 11 ou 14 dígitos) são mascarados na saída do leitor, mantendo os 2 últimos dígitos. O resto da descrição fica como veio. Os logs têm só origem, número de linhas e duração.

### Prévia e conciliação
- **Sem rascunho no servidor:** a prévia volta à tela num **token assinado**.
  - Conteúdo: JSON comprimido + HMAC-SHA256, com chave derivada de `JWT_SECRET` por HKDF.
  - Válido por 2 h e preso à carteira e à pessoa.
  - O identificador da conta ou do cartão de origem vai só em hash.
  - `suggest` (trocar o destino) e `confirm` conferem o token e nunca pedem o arquivo de novo.
- **Destino:** conta para extrato, cartão para fatura. A pré-seleção usa primeiro o `accounts.import_key` (hash da agência/conta ou do final do cartão, gravado na confirmação), depois a única conta do banco do documento.
- **Sugestão por linha:** casar, criar, pagamento de fatura, ignorar ou "já conciliada".
  - **Pontuação** (`scoreMatch`): 0,55·valor + 0,25·data + 0,20·descrição (+0,3 se a parcela "xx/yy" bate), com limiar 0,6.
  - **Valor:** igual vale 1; próximo vale 0,7 (variável até ±50%, fixa ou parcela até ±20%) e gera pergunta ou aviso.
  - **Janela:** 7 dias no extrato e 3 na fatura. Sem data p/ pagamento, vale o mesmo mês.
  - **Atribuição gulosa:** cada lançamento casa com uma linha só.
- **Candidatos do extrato:** ocorrências e projeções fora do crédito da conta (ou sem conta); só a próxima parcela em aberto de cada item; pagamentos já feitos no app viram "já pago" (só vincula).
- **Candidatos da fatura:** ocorrências da fatura do vencimento e recorrentes previstas nela; a data da compra vem da `entry_date` ou do dia da cobrança.
- **Perguntas** (`importQuestions`, regra compartilhada pela tela e pelo servidor):
  - valor menor que o restante → desconto ou parcial;
  - recorrente fixa mais cara → "só este mês" ou "daqui em diante";
  - variável e "já pago" não perguntam.

### Gravação
- **Uma transação**, com lock por destino (`pg_advisory_xact_lock`), reaproveitando o domínio: `createItemTx`, `addPaymentTx`, `payInvoiceTx` e `updateInvoiceDatesTx` (as funções antigas viraram invólucros, sem mudar regra). Erro numa linha desfaz tudo e aponta `decisions.N`.
- **Extrato:**
  - casar quita a ocorrência na data e com o valor da linha (projeção é gravada antes);
  - na variável, o mês passa a valer o que o banco cobrou;
  - na fixa mais cara, "só este mês" usa `patchOccurrence` com `ruleScope: 'occurrence'` (ADR-0004);
  - pagamento de fatura usa `payInvoice`, nunca despesa (ADR-0005);
  - criar gera uma despesa ou entrada única já paga na data da linha.
- **Fatura:**
  - casar só vincula (crédito não tem pagamento próprio);
  - criar põe a compra **nesta** fatura (opção interna `invoiceMonth`), mesmo que a regra compra × fechamento diga outra;
  - "PARC xx/yy" sem casamento cria só as **parcelas restantes** (yy − xx + 1), com a observação "Parcelas xx a yy de yy (importado da fatura)", porque as faturas passadas já estão fechadas;
  - créditos e estornos não viram itens: entram no ajuste;
  - "Usar as datas do banco" ajusta fechamento e vencimento daquele mês;
  - o total do banco vai para `invoices.real_amount_cents` e pré-preenche o pagamento, onde nasce o "Ajuste da fatura" (ADR-0005);
  - fatura já paga não recebe itens (`invoice_closed`).
- **Sem duplicar:** cada linha confirmada (inclusive as ignoradas) grava em `import_lines` uma impressão digital SHA-256 de carteira + destino + data + valor + sentido + documento + descrição normalizada + ordem entre linhas idênticas, com índice único. Reimportar período sobreposto mostra essas linhas como "já conciliadas". `import_batches` guarda origem, destino, período e contagens.
- **Conferência no fim:** "No app, mas não no extrato" (pagamentos do período naquela conta sem linha) e "No app, mas não na fatura" (itens sem linha).

## Testes e fixtures
As fixtures de texto posicionado (`packages/shared/src/imports/__fixtures__/bb-*.json`) são geradas de PDFs reais por `scripts/anonymize-import-fixture.ts`.
- **Troca:** nomes, endereço, CPF/CNPJ, documentos, agência, conta, final do cartão, código de barras, horas e valores.
- **Recalcula:** saldos e total, para a conferência continuar fechando.
- **Garantia:** o script falha se sobrar texto original.
- **Revisão:** feita à mão antes do commit.

Os OFX de exemplo são fictícios. Os testes de integração geram PDFs sintéticos com texto posicionado (`test/import-helpers.ts`), e um PDF sintético com senha está em `test/fixtures/`.

## Consequências
- Mudança de layout do BB quebra o leitor, mas a conferência avisa antes de gravar algo errado, e o OFX continua como alternativa.
- Parcela antiga importada aparece como "1/2", e não "9/10". Mostrar a numeração original exigiria um deslocamento no item.
- Pagar uma fatura não grava as recorrentes previstas dela (comportamento anterior, ver `PROGRESS.md`); a importação casa com a projeção e a grava antes de vincular.
- **Fora desta entrega:** CSV, outros bancos, OFX de cartão, desfazer um lote inteiro e uma tela com o histórico de importações.
