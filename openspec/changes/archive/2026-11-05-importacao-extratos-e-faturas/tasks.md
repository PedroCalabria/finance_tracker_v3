## 1. Preparação

- [x] 1.1 Criar a branch `importacao-extratos-e-faturas` a partir do `main` atualizado. O arquivamento pendente da mudança anterior e o `.gitignore` (`docs/bank-docs-examples/`) seguem na working tree para o commit final.
- [x] 1.2 Adicionar `unpdf` 1.9.1 (versão fixada; pdf.js 6.4.299 empacotado) em `apps/server`, conferir a licença (MIT) e confirmar que nada nativo é instalado (`@napi-rs/canvas` é peer opcional).
- [x] 1.3 Schema (D6):
  - `import_batches`;
  - `import_lines`, com único `(wallet_id, account_id, fingerprint)` e FKs `on delete set null`;
  - `accounts.import_key`.

  Depois, `npm run db:generate` e conferir o SQL gerado em `apps/server/drizzle/`.

## 2. Leitura pura (`packages/shared/src/imports`)

- [x] 2.1 Tipos (`SourceDoc`, `ImportLine`, `ReadResult`, `ImportReader`, dicas) e `index.ts` exportando o catálogo `READERS` e `detectSource`.
- [x] 2.2 Utilitários com teste unitário:
  - `parseCents` ("1.234,56") e `parseCentsDot` ("-123.45");
  - `maskTaxIds` (D11);
  - `normalizeForFingerprint` e a ordem entre linhas idênticas (D7);
  - `inferPurchaseDate` (D2), cobrindo virada de ano e PARC.
- [x] 2.3 Agrupamento por posição: colunas pelo cabeçalho; trechos de histórico para a linha principal mais próxima (até 14 pt), sem cruzar página.
- [x] 2.4 Leitor `bb-extrato-pdf`:
  - detecção;
  - período, agência e conta;
  - linhas com descrição "1º trecho · 2º trecho" sem prefixo de hora;
  - descarte de saldos e blocos informativos;
  - conferência com "Saldo do dia" e "S A L D O" (D4).
- [x] 2.5 Leitor `bb-fatura-pdf`:
  - detecção;
  - final do cartão, vencimento, fechamento e total;
  - seções e portadores;
  - PARC;
  - créditos negativos;
  - saldo anterior e pagamento anterior como informativos;
  - conferência com "Total da Fatura".
- [x] 2.6 Leitor `ofx`: SGML e XML, `STMTTRN`, `TRNAMT`, `DTPOSTED`, `FITID`, `NAME`/`MEMO`, `ACCTID` e período.
- [x] 2.7 Classificação por tabela de regras (D3) para extrato BB, fatura BB e OFX (`TRNTYPE`).
- [x] 2.8 Pontuação de casamento (D8): valor, data, descrição sem palavras genéricas, limiar e atribuição gulosa.
- [x] 2.9 Contratos zod: `importSuggestInput` e `importConfirmInput` (decisões por linha, perguntas obrigatórias conforme a ação) e os tipos de resposta em `api-types.ts`.

## 3. Fixtures anonimizadas

- [x] 3.1 Script `scripts/anonymize-import-fixture.ts` (rodado com `npx tsx`) (D14), que usa a mesma extração do servidor e recalcula saldos e totais.
- [x] 3.2 Gerar `bb-extrato.json` e `bb-fatura.json` a partir dos PDFs de `docs/bank-docs-examples/`. Revisão à mão antes do commit:
  - nenhum nome, CPF, CNPJ, documento, agência, conta, final de cartão, endereço ou valor real;
  - conferências (D4) fechando.
- [x] 3.3 Escrever `exemplo.ofx` (SGML 1.x, CHARSET 1252) e `exemplo-v2.ofx` (XML) fictícios.
- [x] 3.4 Testes unitários dos três leitores sobre as fixtures:
  - contagem de linhas e linhas de referência;
  - dicas (Rende Fácil, Pagto cartão, boleto XP, tarifa, IOF, juros, Finan PF, proventos, PARC, crédito);
  - períodos e totais;
  - conferência sem aviso, e com aviso quando uma linha é removida da fixture.

## 4. Extração no servidor

- [x] 4.1 `src/imports/pdf-text.worker.ts` e `pdf-text.ts`:
  - `unpdf` (`getDocumentProxy`) com `disableFontFace: true` e `useSystemFonts: false` (o pdf.js 6 não tem mais `isEvalSupported`);
  - `worker_threads` com `resourceLimits`, encerramento em 20 s, semáforo de 2 e teto de 50 páginas;
  - senha só em memória;
  - mapeamento de `PasswordException` para `pdf_password_required` e `pdf_password_incorrect`.
- [x] 4.2 Entrada da thread no `tsup.config.ts` e conferência do `npm run build` com `node dist/main-api.js` lendo um PDF.
- [x] 4.3 `src/imports/read-file.ts`:
  - `file-type` (PDF) ou cabeçalho OFX;
  - decodificação do OFX pelo `CHARSET`;
  - `detectSource`, leitura e máscara;
  - logs só com origem, linhas e duração.

## 5. Domínio e API

- [x] 5.1 Refatorar sem mudar regra: `createItemTx`, `addPaymentTx`, `payInvoiceTx` e `updateInvoiceDatesTx`, com as funções atuais virando invólucros. Os testes existentes continuam passando.
- [x] 5.2 `patchOccurrence` com `ruleScope: 'occurrence' | 'forward'` (D10) e a opção interna `invoiceMonth` em `createItemTx` para o crédito (D9).
- [x] 5.3 Token da prévia (D5): HKDF de `JWT_SECRET`, HMAC-SHA256, validade de 2 h e conferência de carteira e pessoa (`import_preview_invalid`).
- [x] 5.4 `domain/imports/candidates.ts`: candidatos do extrato (ocorrências, projeções, já pago, próxima parcela, faturas de cartão) e da fatura (ocorrências e recorrentes previstas da fatura, PARC). Sem `Promise.all` com `tx`.
- [x] 5.5 `domain/imports/preview.ts`:
  - pré-seleção do destino (`import_key`, depois o banco);
  - sugestões com alternativas, perguntas e selos;
  - `already` pela impressão digital;
  - "No app, mas não no extrato/fatura";
  - comparação de datas da fatura.
- [x] 5.6 `domain/imports/confirm.ts` (D9):
  - validação das decisões;
  - lock e impressões digitais;
  - datas da fatura;
  - execução linha a linha com materialização de projeções;
  - `import_lines`, `import_batches`, `import_key` e `real_amount_cents`;
  - erros apontando a linha (`settlement_required`, `import_target_changed`, `import_already_confirmed`, `invoice_closed`).
- [x] 5.7 Rotas em `http/routes/wallet.ts`: `POST /imports/preview` (multipart, 20/min), `/imports/suggest` e `/imports/confirm`, autorizadas por membro da carteira.
- [x] 5.8 Revisar `PayModal` e `InvoicesBlock`: `real_amount_cents` gravado pela importação só pré-preenche o "valor real" no pagamento da fatura.

## 6. Testes de integração (`apps/server/test/imports.test.ts`)

- [x] 6.1 Helpers:
  - gerador de PDF mínimo com texto posicionado, sem dependência;
  - PDF sintético com senha (gerado com `qpdf`, só texto fictício) em `apps/server/test/fixtures/`.
- [x] 6.2 Rotas:
  - arquivo inválido;
  - 10 MB;
  - senha exigida e incorreta;
  - origem desconhecida;
  - prévia sem gravar nada;
  - nada em storage ou disco.
- [x] 6.3 Extrato:
  - recorrente fixa ("Só este mês" e "Daqui em diante");
  - recorrente variável;
  - parcela de financiamento;
  - já pago (só vincula);
  - pagamento de fatura do BB e boleto de cartão XP;
  - `settlement_required`;
  - projeção materializada;
  - criação de Pix e tarifa;
  - pagamentos sem linha.
- [x] 6.4 Reimportação de período sobreposto sem duplicar, duas linhas idênticas no mesmo dia, prévia vencida ou adulterada e confirmação dupla.
- [x] 6.5 Fatura:
  - compra casada;
  - PARC casada;
  - PARC criada só com as restantes;
  - compra perto do fechamento criada nesta fatura;
  - crédito ignorado;
  - datas do banco;
  - valor real gravado e usado depois no ajuste;
  - fatura já paga recusando criação;
  - itens sem linha.
- [x] 6.6 Destino lembrado pelo `import_key` na segunda importação.

## 7. Interface

- [x] 7.1 Item "Importar" no menu (ícone `upload`) e rota `/importar`.
- [x] 7.2 Passo de envio: arrastar e soltar ou escolher arquivo, aceitos e limite, progresso, senha do PDF (campo de senha sem autocompletar), mensagens dos erros da API.
- [x] 7.3 Passo de destino: origem detectada, seletor filtrado (contas ou cartões) e pré-selecionado, avisos de leitura, "+ Nova conta"/"+ Novo cartão" quando não houver destino.
- [x] 7.4 Conciliação:
  - grupos com totais;
  - linha com alvo, alternativas, selos e perguntas;
  - criação com descrição e categoria editáveis;
  - "Já conciliadas" recolhido;
  - seções "No app, mas não…";
  - resumo e datas da fatura;
  - confirmar desabilitado com pendências.
- [x] 7.5 Layout: tabela a partir de 1024px, cards abaixo, sem rolagem horizontal da página, só `ff-*` e tokens.
- [x] 7.6 Confirmação: resumo, "Ver o mês", `invalidateFinance`, erro rolando até a linha.
- [x] 7.7 Roteiro no navegador (Chrome e WebKit, 1440px e celular, claro e escuro) com os PDFs reais de `docs/bank-docs-examples/`, contra um banco temporário, sem gravar capturas com dados reais no repositório.

## 8. Documentação e fechamento

- [x] 8.1 ADR-0010 (`docs/decisions/0010-importacao.md`):
  - desvio da especificação (PDF, CSV depois);
  - fontes e catálogo de leitores;
  - `unpdf` (pdf.js) na thread com limites;
  - prévia assinada sem rascunho;
  - impressão digital;
  - máscara e logs;
  - regras de conciliação;
  - parcelas restantes;
  - valor real antes do pagamento.
- [x] 8.2 Índice em `docs/decisions/README.md` (linha do 0010).
- [x] 8.3 ADR-0004 (`ruleScope` "só este mês" na importação), ADR-0005 (o valor real pode vir da fatura importada e pré-preenche o pagamento) e ADR-0009 (menu "Importar", tela de conciliação).
- [x] 8.4 `PROGRESS.md`: importação na tabela de etapas e nas observações, e a contagem de testes. README, se mudar algum comando ou requisito.
- [x] 8.5 `npm run typecheck`, `npm test` e `npm run build` passando.
- [x] 8.6 Commit único na branch: código, migração, ADRs, PROGRESS e **também** o arquivamento pendente da mudança `ajustes-recorrentes-parcelas-sessao` (pasta de arquivo e `openspec/specs/`) e o `.gitignore`. Conferir com `git status` que `docs/bank-docs-examples/`, `.claude/` e `*.key` ficaram de fora.
