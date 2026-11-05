## Why

Hoje cada pagamento e cada compra no cartão são lançados à mão, e conferir o mês contra o banco é trabalho de olho. A fase 2 da especificação previa importar extrato OFX/CSV com tela de conciliação. O banco principal da família (Banco do Brasil), porém, entrega o extrato da conta e a fatura do Ourocard em **PDF**. Sem ler PDF, a importação não serve para o uso real.

## What Changes

- **Importação de arquivo** em `/api/wallets/:walletId/imports`, com três fontes na primeira entrega:
  - extrato de conta corrente do BB em PDF;
  - fatura do cartão BB (Ourocard) em PDF;
  - OFX genérico de conta.

  A origem (banco e tipo de documento) é detectada pelo conteúdo. Cada fonte tem um leitor puro (texto posicionado → linhas normalizadas) registrado num catálogo, e outro banco entra com um leitor novo, sem mexer no resto.
- **Leitura 100% local** no servidor: o texto do PDF é extraído com `unpdf` (pdf.js empacotado), sem `eval`, numa thread separada com limite de tempo e de memória. Nenhum dado sai da VPS, sem IA e sem serviço externo.
- **Arquivo só em memória:**
  - o arquivo nunca é gravado (nem no R2, nem em disco), e o tipo é validado pelo conteúdo, com limite de 10 MB;
  - PDF com senha pede a senha na tela, que é usada só em memória e nunca registrada;
  - entre o envio e a confirmação não há rascunho no servidor: a prévia volta para a tela com uma assinatura (HMAC) e é conferida na confirmação.
- **Conciliação:** cada linha recebe uma sugestão, que a pessoa pode trocar:
  - casar com um lançamento existente (inclusive mês previsto);
  - criar lançamento novo;
  - pagamento de fatura;
  - ignorar.

  Nada é gravado sem a confirmação, e a gravação acontece numa única transação, reaproveitando `createItem`, `addPayment` e `payInvoice`.
- **Extrato:**
  - quita ocorrências pendentes na data da linha;
  - recorrente variável é paga com o valor do banco;
  - recorrente fixa com valor maior pergunta "só este mês" ou "daqui em diante"; com valor menor, segue a regra de desconto ou parcial;
  - parcela casa com a próxima em aberto;
  - o que já está pago no app só é vinculado, sem pagar de novo;
  - pagamento de fatura vira pagamento da fatura (`payInvoice`), nunca despesa;
  - no fim, lista os pagamentos do app no período que não aparecem no extrato.
- **Fatura:**
  - a fatura é identificada pelo vencimento;
  - as compras casam com os itens da fatura, e "PARC xx/yy" casa com a parcela xx;
  - compra sem casamento sugere criar o item no crédito, com só as parcelas restantes quando a compra é antiga;
  - o total do banco vira o valor real sugerido, e a diferença vai para o "Ajuste da fatura" no pagamento;
  - estornos e créditos aparecem como linhas a decidir;
  - lista os itens do app na fatura sem linha correspondente;
  - oferece ajustar as datas da fatura às do banco.
- **Sem duplicar:** cada linha confirmada (inclusive as ignoradas) guarda uma impressão digital, e reimportar um período sobreposto mostra essas linhas como "já conciliadas".
- **Privacidade:**
  - CPF e CNPJ nas descrições (Pix, proventos) são mascarados antes de qualquer gravação;
  - os logs não levam descrições nem valores;
  - as fixtures de teste são anonimizadas, e os PDFs reais ficam fora do git (`docs/bank-docs-examples/` no `.gitignore`).
- **Interface:**
  - item "Importar" no menu e tela em três passos: arquivo, destino (pré-selecionado pelo banco e lembrado pela conta ou cartão de origem) e conciliação;
  - a conciliação é agrupada por sugestão, com totais (a importar, ignoradas, já conciliadas);
  - abaixo de 1024px vira lista de cards.
- **Desvio da especificação:** a especificação previa só OFX/CSV na fase 2. Entra PDF (BB), e o CSV fica para depois. A mudança fica registrada no ADR novo `0010-importacao.md`, com o índice em `docs/decisions/README.md` e o `PROGRESS.md` atualizados.

## Capabilities

### New Capabilities
- `leitura-de-extratos-e-faturas`: envio do arquivo, validação, detecção da origem, extração de texto local, leitores (BB extrato, BB fatura, OFX), normalização das linhas e regras de segurança e privacidade do arquivo.
- `conciliacao-de-extrato`: sugestões e gravação para linhas de extrato de conta (casamento com ocorrências e projeções, recorrentes fixas e variáveis, parcelas, já pago, pagamento de fatura, novos lançamentos, pagamentos sem linha).
- `conciliacao-de-fatura`: identificação da fatura, casamento de compras e parcelas, criação de itens no crédito, valor real e ajuste, estornos, itens sem linha.
- `tela-de-importacao`: fluxo na interface (menu, envio, senha, destino, conciliação agrupada com totais, confirmação, celular).

### Modified Capabilities
<!-- Nenhuma: as specs existentes (sessão, recorrente, parcelada, exclusão) não mudam de requisito. -->

## Impact

- **Banco:** migração nova com:
  - `import_batches`: registro da importação confirmada (origem, destino, período, contagens; sem o arquivo);
  - `import_lines`: impressão digital de cada linha confirmada e o vínculo com ocorrência, pagamento, fatura ou item;
  - `accounts.import_key`: identificador da conta ou do cartão de origem, guardado só como hash, para pré-selecionar o destino.
- **Servidor:**
  - `domain/imports/*` (prévia, casamento, confirmação) e `imports/pdf-text.ts`, a extração na thread separada (`worker_threads`);
  - nova entrada no `tsup` para essa thread;
  - variantes `…Tx` de `createItem`, `addPayment` e `payInvoice` (as funções atuais passam a chamá-las);
  - `patchOccurrence` ganha a opção "só este mês";
  - rotas em `http/routes/wallet.ts`.
- **Compartilhado:**
  - `packages/shared/src/imports/`: tipos, detecção, leitores, classificação, pontuação de casamento e normalização da impressão digital;
  - contratos zod da prévia e da confirmação;
  - testes unitários com fixtures anonimizadas.
- **Interface:** rota `/importar`, item no menu, página de importação e componentes de conciliação, com estilos em `app.css` só com tokens.
- **Dependência nova:** `unpdf` (pdf.js 6 empacotado), puro JavaScript, sem dependências e sem binário nativo (no servidor).
- **Script de desenvolvimento:** `scripts/anonymize-import-fixture.ts` (rodado com `npx tsx`) gera fixtures anonimizadas a partir de PDFs locais. Ele não roda em produção e não vai para a imagem.
- **Docs:** ADR-0010 novo, índice dos ADRs, `PROGRESS.md`, ADR-0005 (o valor real pode vir da importação antes do pagamento) e ADR-0009 (menu e tela).
