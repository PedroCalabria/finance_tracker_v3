## Context

- **Hoje:** os lançamentos e pagamentos são manuais. A fase 2 da especificação previa importar extrato OFX/CSV com conciliação. O `PROGRESS.md` já registra duas regras: reaproveitar `createItem` e `addPayment`, e casar o pagamento de fatura com a fatura (`payInvoice`), nunca como despesa (ADR-0005).
- **Fontes da primeira entrega:**
  - extrato de conta corrente do BB em PDF;
  - fatura do Ourocard (BB) em PDF;
  - OFX de conta de qualquer banco.
- **Exemplos reais:** os PDFs estão em `docs/bank-docs-examples/`, agora no `.gitignore`.

**O que a leitura dos exemplos mostrou**, extraindo o texto com posição (só a estrutura; nenhum dado vai para os artefatos):
- **Extrato BB, texto corrido não serve:**
  - O cabeçalho tem "Extrato de Conta Corrente", "Cliente", "Período: dd a dd/mm/aaaa", "Agência" e "Conta", e as colunas `Dia | Lote | Documento | Histórico | Valor` têm posições x fixas.
  - Cada lançamento tem uma **linha principal** com data, lote, documento e valor ("1.234,56 (+)" ou "(-)"). O histórico tem até três trechos, que ficam **acima, na mesma altura ou abaixo** dessa linha (cerca de +5 a +12 pt e −6 a −12 pt).
  - Extratores por linha de texto, como o `pdftotext -layout` que testei, **embaralham valor e histórico**. É preciso agrupar pela posição: cada trecho de histórico vai para a linha principal mais próxima na vertical.
  - "Saldo do dia" fica na mesma altura da linha principal; "S A L D O" fecha o período; "Informações Adicionais" e "Informações Complementares" vêm depois.
- **Fatura Ourocard:**
  - **Primeira página:** resumo com "Vencimento", "Total" e "Final NNNN".
  - **Segunda página:** "Fatura fechada em dd/mm/aaaa".
  - **Lançamentos:** colunas `Data | Descrição | País | Valor`, com data em "dd/mm" **sem ano** e valor "R$ 1.234,56" (negativo para créditos), agrupados em seções ("Pagamentos/Créditos", "Educação", "Supermercados", …, "Compras parceladas", "Outros lançamentos"). "PARC xx/yy" vem dentro da descrição, e "Total da Fatura" fecha a lista.
  - **Conferência:** saldo anterior + compras − créditos = total, o que dá uma conferência forte.
- **Código existente:** `createItem`, `addPayment`, `payInvoice` e `updateInvoiceDates` abrem cada um a sua transação, e `invoices.real_amount_cents` já existe (gravado hoje só no pagamento). O upload de comprovantes já usa `@fastify/multipart` (10 MB) e `file-type`.

## Goals / Non-Goals

**Goals:**
- Ler as três fontes localmente, com conferência de integridade, num catálogo de leitores puros e testáveis.
- Sugerir a conciliação de cada linha e gravar só o que a pessoa confirmar, numa transação, sem duplicar em reimportações.
- Não guardar o arquivo nem linhas não confirmadas; mascarar CPF e CNPJ; logs sem dados.
- Funcionar no celular e seguir o design system.

**Non-Goals:**
- CSV, outros bancos (XP, Nubank…) e OFX de cartão de crédito (`CREDITCARDMSGSRSV1`): a arquitetura permite acrescentá-los depois.
- Importação automática (Open Finance, email) e desfazer uma importação inteira. Desfazer pagamentos e itens um a um continua possível pelas telas atuais.
- Compras internacionais com moeda estrangeira na fatura: entram só pelo valor em reais, se estiverem na lista.
- Categorizar sozinho além de uma dica simples (seção da fatura com o mesmo nome de uma categoria da pessoa).

## Decisions

### D1. Extração do PDF com `unpdf` (pdf.js empacotado), numa thread separada
- **Biblioteca:** `unpdf` 1.9.1 (MIT), que traz o **pdf.js 6.4.299** empacotado para ambientes sem canvas. O pacote não tem dependências; `@napi-rs/canvas` é um peer **opcional** e não é instalado. O bundle não contém `eval` nem `new Function`, e a CVE-2024-4367 foi corrigida no pdf.js 4.2.67. No pdf.js 6, a opção `isEvalSupported` deixou de existir junto com esse caminho, e passamos `disableFontFace: true` e `useSystemFonts: false`. A biblioteca devolve cada trecho com a matriz de posição (x, y), resolve a senha (`password`, com `PasswordException` NEED_PASSWORD e INCORRECT_PASSWORD) e, nos dois PDFs de exemplo, produziu exatamente as mesmas posições do `pdfjs-dist`.
- **Por que não o `pdfjs-dist` direto:** o build `legacy` (4.x e 5.x) tem `@napi-rs/canvas` (binário nativo) como dependência opcional, que o npm instala por padrão, e tenta carregá-lo ao iniciar. Sem ele, a 5.x quebra ao carregar (`DOMMatrix`), e a 4.x funciona, mas emite avisos. Isso contraria "sem dependência nativa".
- **Alternativas consideradas:**
  - `pdf-parse`: embute um pdf.js antigo e devolve só texto corrido, sem posição.
  - `pdf2json`: tem posição, mas é menos mantida e usa o próprio parser.
  - `pdftotext` (poppler/xpdf): binário nativo, e o layout embaralha as colunas, como vi nos exemplos.
- **Isolamento:** `apps/server/src/imports/pdf-text.ts` roda a extração num `worker_threads` com `resourceLimits` (`maxOldGenerationSizeMb: 256`), encerrado depois de 20 s (`import_timeout`). Há no máximo 2 extrações simultâneas por processo (semáforo; a terceira espera) e um teto de 50 páginas.
- **Saída da thread:** `SourceDoc { kind: 'pdf', pages: [{ width, height, items: [{ x, y, w, text }] }] }`, com `y` na origem do PDF (de baixo para cima).
- **Build:** a thread tem entrada própria no `tsup` (`src/imports/pdf-text.worker.ts`) e é localizada com `new URL('./pdf-text.worker.js', import.meta.url)`.

### D2. Catálogo de leitores puros em `packages/shared/src/imports`
```ts
interface ImportReader {
  id: 'bb-extrato-pdf' | 'bb-fatura-pdf' | 'ofx' | string;
  bank: string;                         // "Banco do Brasil"; OFX: o do <ORG>/<BANKID>, se houver
  kind: 'statement' | 'invoice';
  detect(doc: SourceDoc): boolean;      // pelo conteúdo, nunca pela extensão
  read(doc: SourceDoc): ReadResult;     // linhas normalizadas + cabeçalho + avisos
}
```
- `SourceDoc` é `{ kind: 'pdf', pages }` ou `{ kind: 'text', text }`. O OFX chega como texto, decodificado no servidor pelo `CHARSET` do cabeçalho (1252, UTF-8 ou ASCII) com `TextDecoder`.
- `ReadResult = { header: { periodStart?, periodEnd?, accountRef?, invoice?: { dueDate, closingDate?, totalCents } }, lines: ImportLine[], warnings: ReadWarning[] }`.
- `ImportLine = { date, amountCents, direction, description, document?, hint, section?, parcel?: { n, of }, order }`.
- `detectSource(doc)` percorre `READERS` e devolve o primeiro que reconhece. Um leitor novo é um arquivo novo mais uma entrada no array.
- **Leitor `bb-extrato-pdf`:**
  - Acha as colunas pelo cabeçalho de cada página (x de "Dia", "Histórico" e "Valor").
  - Linhas principais são as que têm data `dd/mm/aaaa` na coluna Dia.
  - Cada trecho da coluna Histórico vai para a linha principal mais próxima em y (até 14 pt), sem cruzar página, e os trechos ficam na ordem de cima para baixo.
  - O valor tem a regex `^([\d.]+,\d{2}) \(([+-])\)$`.
  - O período, a agência e a conta saem do cabeçalho.
  - Descarta "Saldo Anterior", "Saldo do dia", "S A L D O" e tudo depois de "Informações Adicionais", mas usa os saldos na conferência (D4).
  - A descrição é o 1º trecho mais " · " mais o 2º, sem o prefixo "dd/mm hh:mm" do Pix.
- **Leitor `bb-fatura-pdf`:**
  - Reconhece "OUROCARD" mais "Lançamentos nesta fatura".
  - Linhas são as que têm `dd/mm` na coluna Data e "R$ …" na coluna Valor.
  - Títulos sem data na coluna Descrição viram `section`, e `PARC (\d{2})/(\d{2})` vira `parcel`.
  - "SALDO FATURA ANTERIOR" e "PGTO." na seção "Pagamentos/Créditos" viram `invoice_previous_balance`, informativo.
  - "Final NNNN", "Vencimento", "Fatura fechada em" e "Total da Fatura" vêm por rótulo.
  - Pode haver mais de uma seção de portador ("Nome (Cartão NNNN)"), todas na mesma fatura.
- **Ano das datas da fatura (`inferPurchaseDate`):**
  - escolher o ano em que a data fica ≤ fechamento e mais perto do mês esperado: o mês de referência − (xx − 1) para parcelas, ou o fechamento para compras à vista;
  - sem fechamento, usar o vencimento − 10 dias.
- **Leitor `ofx`:**
  - Faz um parser tolerante de SGML 1.x e XML 2.x por blocos `<STMTTRN>`.
  - Lê `TRNAMT` com ponto decimal e sinal, `DTPOSTED` (os 8 primeiros dígitos), `FITID` (como documento), `NAME`/`MEMO` (como descrição) e `TRNTYPE` (como dica).
  - `BANKACCTFROM/ACCTID` vira `accountRef`, e `DTSTART`/`DTEND` viram o período.
- **Valores:** `parseCents("1.234,56")` e `parseCentsDot("-123.45")` em inteiros, sem `Number` de ponto flutuante no caminho.

### D3. Classificação por tabela de regras
A dica de tipo, a ação padrão, o método da criação e a explicação vêm de uma tabela por leitor (regex sobre a descrição normalizada), testada em `classify.test.ts`. A tabela inicial do extrato BB:

| Regra | Dica | Ação padrão | Método na criação |
| --- | --- | --- | --- |
| `BB RENDE FACIL`, `RENDE FACIL` | `investment_sweep` | ignorar ("Aplicação/resgate automático") | — |
| `PAGTO CARTAO CREDITO` | `invoice_payment` (banco do extrato) | pagamento de fatura | — |
| `PAGAMENTO DE BOLETO` + favorecido `BANCO <X>` | `invoice_payment` (banco X), se houver cartão do banco X; senão `boleto` | fatura ou criar | boleto |
| `TARIFA`, `COBRANCA DE I.O.F`, `JUROS SALDO DEVEDOR`, `COBRANCA DE JUROS` | `fee` | criar (categoria "Outros", se existir) | débito |
| `PAGAMENTO BB FINAN` | `financing` | casar; senão criar | débito |
| `RECEBIMENTO DE PROVENTOS` | `salary` | casar; senão criar entrada | transferência |
| `PIX - ENVIADO` / `PIX - RECEBIDO` | `pix` | casar; senão criar | pix |
| `COMPRA COM CARTAO` | `debit_card` | casar; senão criar | débito |
| `PAGAMENTO DE BOLETO`, `PAGAMENTO CONTA` | `boleto` | casar; senão criar | boleto |

Na fatura:
- `IOF`, `JUROS`, `TARIFA` e `ANUIDADE` → `fee`, e a ação padrão é criar;
- valor negativo fora de "PGTO." → `refund`, e a ação padrão é ignorar ("Entra no ajuste da fatura");
- o resto → `purchase` ou `installment`, e a ação padrão é casar; senão, criar.

### D4. Conferência de integridade
- **Extrato BB:** a partir do "Saldo Anterior", soma os movimentos dia a dia e compara com cada "Saldo do dia" e com "S A L D O".
- **Fatura:** soma todas as linhas, inclusive saldo anterior e pagamentos, e compara com "Total da Fatura".

Diferenças viram `warnings` com dia e valor e aparecem na prévia, sem bloquear. Esse é o principal alarme se o BB mudar o layout.

### D5. Prévia sem estado no servidor, assinada com HMAC
- **Fluxo:** `preview` lê o arquivo e devolve à tela as linhas normalizadas (já mascaradas) dentro de um **token**: `base64url(JSON)` mais um HMAC-SHA256.
  - **Chave:** derivada de `JWT_SECRET` por HKDF com o rótulo `ff-import-preview`, sem variável de ambiente nova.
  - **Conteúdo:** `walletId`, `userId`, `readerId`, cabeçalho (com `accountRef` só em hash), linhas e validade de 2 h.
  - **Uso:** `suggest` e `confirm` recebem o token, conferem a assinatura, a carteira, a pessoa e a validade (`import_preview_invalid`) e nunca precisam do arquivo de novo.
- **Por quê:** nada fica guardado entre o envio e a confirmação, então não há tabela de rascunho, limpeza no worker nem linhas não confirmadas no banco. O token vive só na memória da página, nunca no `localStorage`, e trafega por HTTPS. Um extrato de 150 linhas dá um token de cerca de 25 KB, abaixo do `bodyLimit` (1 MB).
- **Alternativa:** um rascunho `import_drafts` com expiração de 24 h e limpeza no worker. Ela foi rejeitada porque guarda dados bancários não confirmados e exige limpeza.

### D6. Modelo de dados (migração nova)
- `import_batches`: `id`, `wallet_id`, `account_id`, `reader_id`, `kind`, `period_start`, `period_end`, `invoice_id` (fatura), `counts` (jsonb: casadas, criadas, faturas, ignoradas, vinculadas), `created_by`, `created_at`. É o registro da importação confirmada, sem arquivo e sem linhas não confirmadas.
- `import_lines`, uma por linha confirmada:
  - `id`, `wallet_id`, `batch_id`, `account_id`;
  - `fingerprint char(64)`, com **único `(wallet_id, account_id, fingerprint)`**;
  - `line_date`, `amount_cents`, `direction`, `description` (mascarada), `document`;
  - `action` (`paid`, `linked`, `created`, `invoice_paid`, `ignored`);
  - `occurrence_id`, `payment_id`, `invoice_id`, `invoice_payment_id` e `item_id`, todos `on delete set null`;
  - `created_at`.
- `accounts.import_key text null`: `sha256(walletId + ':' + readerBank + ':' + accountRef)`, onde `accountRef` é "agência/conta" no extrato, "final NNNN" na fatura ou `ACCTID` no OFX. Ele é gravado na confirmação e serve para pré-selecionar o destino. Não há índice único: a mesma origem pode ir para destinos diferentes, e vale a última confirmada.
- **Sem migração de dados.** Depois de mudar o schema, rodar `npm run db:generate` e commitar a migração.

### D7. Impressão digital
- **Normalização** (em `shared`, com teste): descrição em maiúsculas, sem acentos e com espaços colapsados, já mascarada.
- **Ordem:** posição 1, 2, … entre linhas com a mesma tupla (data, valor, sentido, documento, descrição) dentro do arquivo, na ordem de leitura.
- **Hash** (no servidor, `node:crypto`): `sha256(walletId|accountId|date|amount|direction|document|descNorm|order)`.
- **Proteção extra:** o índice único também barra duas confirmações simultâneas da mesma prévia (409 `import_already_confirmed`), e um `pg_advisory_xact_lock(hash(wallet, account))` serializa confirmações do mesmo destino.

### D8. Casamento
- **Pontuação** (função pura em `shared/imports/match.ts`, com testes): `0,55·valor + 0,25·data + 0,20·descrição`.
  - **Valor:** 1 se igual. Na recorrente variável, 0,7 com até ±50%. Na fixa ou na parcela, 0,7 com até ±20% (o que dispara a pergunta ou o aviso).
  - **Data:** `1 − |Δdias|/8` no extrato; na fatura, `1 − |Δdias|/4`.
  - **Descrição:** coeficiente de Dice sobre palavras, sem as genéricas (PIX, ENVIADO, PAGAMENTO, BOLETO, DE, DA, COMPRA, CARTAO…).
  - **Limiar:** 0,6. Abaixo dele, `create`.
- **Atribuição gulosa:** as linhas são processadas em ordem decrescente de melhor pontuação, e cada ocorrência é usada no máximo uma vez por importação. As 3 melhores aparecem como alternativas.
- **Candidatos do extrato** (no servidor, `domain/imports/candidates.ts`):
  - ocorrências gravadas e projeções (`projectionsFor` em cada mês do período) fora do crédito;
  - do tipo do sentido, com `account_id` igual ao destino ou nulo;
  - data p/ pagamento a até 7 dias da linha (sem data, no mesmo mês);
  - status pendente ou parcial, ou pago com pagamento a até 7 dias e de mesmo valor (vira "já pago": só vincula);
  - na parcela, só a próxima em aberto de cada item.
- **Candidatos de fatura de cartão** (linha `invoice_payment`): faturas abertas ou atrasadas do cartão do banco indicado, com vencimento a até 10 dias.
- **Candidatos da fatura:**
  - ocorrências da fatura de destino mais as recorrentes previstas para ela (`projectionsFor` no mês de referência, filtradas pelo cartão);
  - a data do item é `entry_date` na única e na parcelada, ou o dia da cobrança no mês da cobrança na recorrente;
  - com `parcel`, há bônus quando `installmentNumber = xx` e `installments = yy`.

### D9. Gravação numa transação, reaproveitando o domínio
- **Refatoração mínima, sem mudar regra:** `createItem`, `addPayment`, `payInvoice` e `updateInvoiceDates` passam a ser invólucros de `createItemTx`, `addPaymentTx`, `payInvoiceTx` e `updateInvoiceDatesTx`, que recebem `tx`. As rotas atuais continuam iguais, e os testes existentes cobrem a refatoração.
- **`confirmImport(db, walletId, userId, token, accountId, decisions, clock)`:**
  1. Confere o token e as decisões com o zod `importConfirmInput`: cada linha decidida, alvos do tipo certo e perguntas respondidas. Os erros apontam a linha (`fields: { "decisions.7": "…" }`).
  2. Abre a transação, pega o lock (D7) e recalcula as impressões digitais. Linhas que já existem viram `already`, e a gravação delas é pulada.
  3. **Fatura:** se "Usar as datas do banco" estiver marcado, chama `updateInvoiceDatesTx` antes de criar itens.
  4. Para cada linha, na ordem do arquivo:
     - `match`: `materializeProjection` e `getOccurrenceChecked`. A `version` não é exigida, mas a ocorrência precisa continuar elegível. Se mudou desde a prévia (alguém pagou), responde 409 `import_target_changed` com a linha.
       - **Extrato:** ajusta o previsto quando precisa (variável: só este mês; fixa com "Só este mês": `patchOccurrence` com o novo `ruleScope: 'occurrence'`; com "Daqui em diante": o comportamento atual) e chama `addPaymentTx` com `paidAt = data` e `settlement`.
       - **Já pago:** só vincula `payment_id`.
       - **Fatura:** só vincula `occurrence_id`.
     - `invoice_payment`: `payInvoiceTx` com o valor real escolhido, o valor da linha e a data. Se a fatura já tem pagamento de mesmo valor a até 3 dias, só vincula.
     - `create`, no extrato: `createItemTx` com uma única, `alreadyPaid` e `date = dueDate = data da linha`. Como o `alreadyPaid` atual paga com `notAfterToday(date)`, a data do extrato é sempre ≤ hoje.
     - `create`, na fatura: `createItemTx` no crédito com a opção interna `invoiceMonth`, que força a 1ª ocorrência nesta fatura. Na parcelada antiga, `installments = yy − xx + 1`, total = valor × restantes, e a observação vai na 1ª.
     - `ignore`: nenhuma escrita no domínio.
  5. Insere as `import_lines` (inclusive as ignoradas), o `import_batches` e o `accounts.import_key`.
  6. **Fatura:** grava `real_amount_cents` na fatura aberta.
- **Sem paralelismo:** nenhuma consulta com `Promise.all` dentro da transação, por causa da armadilha registrada no CLAUDE.md.

### D10. "Só este mês" no valor da recorrente
`patchOccurrence` ganha `ruleScope: 'forward' | 'occurrence'`, com padrão `'forward'` (o comportamento atual). Com `'occurrence'`, muda só o previsto do mês e não toca na regra nem nos meses seguintes. Uso dentro da importação, e ADR-0004 atualizado.

### D11. Máscara de CPF e CNPJ
`maskTaxIds(text)` (em `shared`, com teste) troca `\d{3}\.\d{3}\.\d{3}-\d{2}`, `\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}` e sequências isoladas de 11 ou 14 dígitos (`(?<!\d)\d{11}(?!\d)`, idem 14) por `•` mais os 2 últimos dígitos. Ela é aplicada **na saída do leitor**, antes do token: nada sem máscara sai da prévia. O documento da coluna "Documento" do BB (número interno do lançamento) não é mascarado. O identificador da conta ou do cartão vai no token só em hash, mais a forma exibível "final ••12".

### D12. Contratos da API (sob `/api/wallets/:walletId/imports`)
| Rota | Entrada | Saída |
| --- | --- | --- |
| `POST /preview` (multipart; limite próprio de 20/min) | `file`, `password?` | `{ token, source: { readerId, bank, kind, label }, header, warnings, destinations: { options, suggestedAccountId }, suggestions? }` |
| `POST /suggest` | `{ token, accountId }` | `{ lines: [{ index, line, suggestion: { action, target?, alternatives, questions, badges, explanation } }], unmatchedApp, invoice? }` |
| `POST /confirm` | `{ token, accountId, decisions: [{ index, action, occurrenceId?, invoiceId?, create?: { description, categoryId?, method? }, amountScope?, settlement?, realAmountCents? }], invoice?: { useBankDates, realAmountCents } }` | `{ batchId, counts, months }` |

**Códigos de erro:**
- `import_unsupported_file` (400) e 413 (tamanho);
- `pdf_password_required` e `pdf_password_incorrect` (422);
- `import_timeout` e `import_unknown_source` (422);
- `import_preview_invalid` (400);
- `import_target_changed`, `import_already_confirmed` e `invoice_closed` (409);
- `settlement_required` (400, com a linha).

### D13. Interface
- **Estrutura:** rota `/importar` (`pages/ImportPage.tsx`), com item "Importar" no `AppShell` (ícone novo `upload`). Os passos são locais (`useState`/`useReducer`):
  1. envio;
  2. senha, se for o caso;
  3. destino e conciliação;
  4. resultado.
- **Componentes:** `ImportDropzone`, `ReconcileGroups` (tabela `ff-table` a partir de 1024px; abaixo disso, `ff-occ` em cards, usando o `useIsMobile` com a consulta `(max-width: 1023px)`), `LineDecision` (`ff-select` da ação e do alvo, com as perguntas em `Segmented`) e `ImportTotals` (`ff-summary`). Só tokens e `app.css`.
- **Teclado:** foco no primeiro campo pendente ao tentar confirmar; grupos com `<details>`/`<summary>` ("Já conciliadas" recolhido).

### D14. Fixtures anonimizadas
- **Script** `scripts/anonymize-import-fixture.ts <pdf> <saida.json>` (rodado com `npx tsx`): só desenvolvimento, usa o mesmo `pdf-text` e não entra na imagem.
  - **Trocas:** nomes por nomes fictícios de uma lista; CPF/CNPJ por números fictícios válidos de formato; documentos, lote, agência, conta e final do cartão por números aleatórios do mesmo tamanho; valores por valores aleatórios.
  - **Recálculo:** "Saldo do dia", "S A L D O", resumo e "Total da Fatura" são recalculados para a conferência (D4) continuar fechando.
  - **Preservado:** posições x e y, ordem e rótulos fixos do banco ("Pix - Enviado", "Pagto cartão crédito", "PARC 09/10"…).
- **Saída:** `packages/shared/src/imports/__fixtures__/bb-extrato.json` e `bb-fatura.json`, revisados à mão antes do commit (checklist na tarefa), mais `exemplo.ofx` escrito à mão.

### D15. Testes
- **Unitários (`shared`):**
  - detecção;
  - os três leitores sobre as fixtures (contagem de linhas, primeira e última linha, períodos, totais e conferência fechando);
  - `inferPurchaseDate`, `parseCents`, `maskTaxIds`, normalização da impressão digital, classificação e pontuação de casamento.
- **Integração (`apps/server/test/imports.test.ts`):**
  - **Rotas:** um helper gera um PDF mínimo válido com texto posicionado (escrito à mão, sem dependência), para testar a rota de verdade. Um PDF sintético com senha (gerado uma vez com `qpdf` e commitado, só com texto fictício) cobre `pdf_password_required` e `pdf_password_incorrect`.
  - **Casamento e gravação:** recorrente fixa ("Só este mês" e "Daqui em diante") e variável, parcela, já pago, pagamento de fatura, `settlement_required`, reimportação sem duplicar, projeção materializada, fatura com compra casada, PARC casada e criada (restantes), datas do banco, valor real gravado e depois usado no ajuste, prévia vencida ou adulterada e confirmação dupla.

## Risks / Trade-offs

- **[Risco]** O BB muda o layout do PDF. → A detecção falha (`import_unknown_source`) ou a conferência acusa diferença. Os leitores ficam isolados e testados por fixture, e o OFX continua como alternativa.
- **[Risco]** PDF malicioso ou gigante. → pdf.js (via `unpdf`) sem `eval`, thread com limite de memória e de tempo, teto de páginas e de concorrência, e o tipo validado antes.
- **[Risco]** A impressão digital muda se o banco reemitir o documento ou se o arquivo cortar um dia pela metade. → Pode gerar duplicata. Nesse caso, o casamento ainda vê a ocorrência como "já pago" e sugere só vincular, então o pagamento não duplica.
- **[Trade-off]** Parcelada antiga cria só as parcelas restantes (rótulo "1/2" em vez de "9/10"). → A observação registra "Parcelas 9 a 10 de 10". Mostrar a numeração original exigiria um deslocamento no item (`first_installment`), que fica como melhoria futura.
- **[Trade-off]** O token da prévia vai e volta com as linhas (cerca de 25 KB). → Aceitável para evitar guardar dados não confirmados.
- **[Risco]** Sugestão errada. → Nada é gravado sem confirmação, cada linha mostra o alvo e as alternativas, e os erros de confirmação apontam a linha.
- **[Risco]** Gravar `real_amount_cents` antes do pagamento pode confundir telas que hoje o tratam como "já pago". → Revisar `InvoicesBlock` e `PayModal` da fatura: o valor só pré-preenche o campo.
- **[Trade-off]** `unpdf` (cerca de 2 MB de pdf.js empacotado) aumenta a imagem. → Aceitável, porque roda só na API.

## Migration Plan

1. Migração SQL nova (tabelas e coluna), gerada com `npm run db:generate` e commitada. `main-migrate` aplica na subida, como hoje.
2. API e interface sobem juntas na mesma imagem.
3. Rollback: voltar a imagem. As tabelas novas ficam sem uso, e os pagamentos e itens criados pela importação continuam válidos, porque são registros normais do domínio.

## Open Questions

- Encargos da fatura (IOF, juros): criar item, como está o padrão, ou deixar ir para o ajuste? Decidir depois das primeiras faturas reais.
- Mostrar a numeração original das parcelas importadas (`first_installment`)?
- Uma tela "Importações" com o histórico dos `import_batches` e a opção de desfazer um lote inteiro fica para depois.
- CSV (previsto na especificação) entra com o primeiro banco que só ofereça CSV.
