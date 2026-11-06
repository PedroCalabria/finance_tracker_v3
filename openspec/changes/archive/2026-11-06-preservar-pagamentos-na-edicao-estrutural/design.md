## Context

`editItem` em `apps/server/src/domain/items.ts` separa as edições em simples e estruturais. Na estrutural, `rebuild` apaga todas as ocorrências do item e chama `writeOccurrences`, que grava de novo:
- única e parcelada: insere todas as linhas planejadas;
- recorrente: chama `ensureMaterialized`, que grava os meses até o mês atual e **pula os meses que já têm ocorrência**.

Hoje, apagar uma ocorrência com pagamento destruiria dados, porque `payments.occurrence_id` tem `onDelete: cascade`. Além disso, os comprovantes ficam ligados ao `group_id` do pagamento, sem FK, e `import_lines.occurrence_id`/`payment_id` passariam a nulo. Por isso `rebuild` recusa com 409 qualquer item com pagamento. A interface (`ItemFormModal`, `blocked`) espelha essa recusa.

Restrições do schema que importam aqui:
- `occurrences_item_month_uq`: (item, mês) único quando `installment_number` é nulo;
- `occurrences_item_installment_uq`: (item, parcela) único quando não é nulo.

Itens no crédito nunca têm pagamento próprio: tudo passa pela fatura.

## Goals / Non-Goals

**Goals:**
- Permitir edição estrutural com pagamentos sempre que existir um lugar equivalente na sequência nova, sem perder nem copiar pagamento, comprovante, vínculo de importação ou observação.
- Recusar com mensagem específica e código estável quando não existir esse lugar.
- Ter uma única regra de mapeamento, usada pelo servidor e pelo aviso da interface.

**Non-Goals:**
- Liberar a edição quando há parte numa fatura já paga. A recusa continua.
- Mover pagamentos de fatura ou mexer em itens no crédito.
- Mudar a API: mesma rota, mesmo corpo. Só o 409 vira 200 nos casos que cabem.
- Mudar o schema.

## Decisions

### 1. Preservar a ocorrência paga em vez de mover os pagamentos
A ocorrência paga fica no banco, com o mesmo id, e é **reposicionada**: recebe número da parcela, mês e data p/ pagamento do lugar equivalente. Só as ocorrências sem pagamento são apagadas.

- *Alternativa: recriar tudo e fazer `UPDATE payments SET occurrence_id`.* O cascade obriga a mover antes de apagar, mas a ocorrência de destino só existe depois de gravar. Seria preciso estacionar as ocorrências antigas, e na recorrente `ensureMaterialized` pularia o mês delas mesmo assim. Também seria preciso mover `import_lines` à mão. Mais passos, mais chance de esquecer um vínculo.
- *Vantagem da escolhida:* `payments`, `attachments` e `import_lines` não são tocados. A observação também fica.

### 2. Regra pura `paidTargets` em `packages/shared/src/rebuild.ts`
Entrada:
- a forma de origem;
- se o tipo mudou;
- se o destino é crédito;
- as ocorrências pagas (`competenceMonth`, `installmentNumber`);
- a sequência nova:
  - `{ form: 'single' }`;
  - `{ form: 'installment', months }`, com o mês de cada parcela;
  - `{ form: 'recurring', startMonth, endMonth }`.

Saída: `{ ok: true, targets }`, com um destino por ocorrência paga, ou `{ ok: false, message }`.

Ordem das verificações: tipo, crédito, depois o mapeamento:
- parcelada → parcelada: pelo número;
- → única: no máximo uma paga;
- demais casos: pelo mesmo mês;
- por fim, destinos repetidos.

Por número entre parceladas porque mudar a data de uma parcela desloca todos os meses, mas "a 1ª parcela foi paga" continua verdade. Pelo mês nos demais casos porque, entre formas diferentes, o mês de competência é o que a pessoa reconhece: o pagamento de outubro fica em outubro.

O servidor monta `months` a partir das linhas que `writeOccurrences` planejou. A interface monta com `installmentDueDates`/`firstInstallmentDue`, do mesmo jeito que `rebuild`.

### 3. `writeOccurrences` aceita um "reaproveitamento"
Para única e parcelada, `writeOccurrences` passa a receber um parâmetro opcional `reuse(planned)`. Ele devolve, para cada linha planejada, o id da ocorrência paga que deve recebê-la. Essas linhas viram `UPDATE`: mês, parcela, data, valor, `invoice_id` nulo e `version + 1`. As demais continuam `INSERT`.

Para recorrente, `rebuild` normaliza as ocorrências pagas antes de gravar: parcela nula, data pelo dia da regra nova e `invoice_id` nulo. Depois, `ensureMaterialized` pula esses meses sozinho.

O mapeamento roda dentro da transação, depois que as ocorrências sem pagamento foram apagadas. Se ele recusar, o `throw` desfaz tudo.

Não há colisão de índice único:
- ao virar recorrente, os destinos são meses distintos, porque a regra recusa repetidos;
- ao virar parcelada, os destinos são números distintos e as linhas inseridas têm número;
- ao virar única, há uma só linha.

### 4. Valor previsto da ocorrência preservada
- Destino parcela ou única: o valor da sequência nova (divisão do total ou o valor informado), porque o total precisa fechar.
- Destino recorrente:
  - na linha aberta, o valor informado, como já faz a edição simples;
  - nos outros meses pagos, o valor que tinham, porque o histórico não muda quando a regra muda (ADR-0004: "o valor pago nunca altera meses seguintes").

Depois, `refreshStatus` em cada ocorrência preservada, que mantém `settled_with_discount`.

### 5. Código `payments_not_movable`
Um código só, com mensagens específicas por motivo. A mensagem já diz o que fazer, e a interface não precisa distinguir os casos. A mensagem antiga de recorrente ("Encerre a recorrência e cadastre de novo") deixa de existir.

## Risks / Trade-offs

- [O formulário não conhece meses futuros pagos adiantado, porque o detalhe só traz até o próximo mês] → o servidor é a fonte da verdade e devolve a mesma mensagem. O aviso prévio é só uma ajuda.
- [Uma parcela paga pode virar "parcial" se a nova divisão aumentar o valor dela] → é o reflexo correto: ainda falta pagar a diferença. Fica documentado no cenário.
- [Mudança para a forma única mantém a ocorrência paga mesmo se a data da única cair noutro mês] → é o comportamento esperado: a única está no mês da data dela, e o pagamento a acompanha.
- [Ocorrências preservadas mantêm `created_at` antigo] → nenhum código depende disso.

## Migration Plan

Não há migração de dados nem de schema. O deploy é comum. Para reverter, basta voltar o código: os dados gravados são válidos nas duas versões.
