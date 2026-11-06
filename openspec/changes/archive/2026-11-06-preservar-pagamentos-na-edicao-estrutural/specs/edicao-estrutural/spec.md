## ADDED Requirements

### Requirement: Edição estrutural preserva as ocorrências pagas
Uma edição estrutural (ADR-0004) SHALL recriar os meses do lançamento como num cadastro novo, com o mesmo id. Isso vale para mudar tipo, forma, nº de parcelas, valor total, entrar ou sair do crédito, trocar o cartão, a data da compra no crédito, o mês de início, o dia da cobrança no crédito ou a data de uma parcela fora do crédito. As ocorrências **com pagamento** SHALL ser mantidas, com o mesmo id, e reposicionadas no lugar equivalente da sequência nova. Seus pagamentos, comprovantes, vínculos com linhas importadas e observações SHALL continuar ligados a elas. Só as ocorrências sem pagamento SHALL ser apagadas e recriadas.

Na ocorrência paga reposicionada:
- número da parcela, mês e data p/ pagamento SHALL seguir a sequência nova;
- o valor previsto SHALL seguir a sequência nova quando o destino for uma parcela, a compra única ou a linha aberta na edição;
- num mês de recorrente que não é a linha aberta, o valor previsto SHALL continuar o que era;
- o status SHALL ser recalculado a partir dos pagamentos, mantendo "quitado com desconto".

#### Scenario: Única paga vira recorrente
- **WHEN** uma despesa única de R$ 3.518,00 em boleto, de outubro de 2026, foi paga em 01/10/2026 pela importação do extrato, e a pessoa a transforma em "Todo mês" com mês de início outubro de 2026 e dia 1
- **THEN** o lançamento passa a ser recorrente com o mesmo id, outubro continua pago com o mesmo pagamento e a mesma ocorrência, com data p/ pagamento 2026-10-01, a linha do extrato continua vinculada a ela, e novembro em diante seguem a regra nova

#### Scenario: Única paga vira parcelada
- **WHEN** uma despesa única paga em outubro de 2026 é transformada numa parcelada fora do crédito de 3 parcelas com a 1ª em 2026-10-10
- **THEN** a ocorrência paga vira a parcela 1/3 com o valor da parcela e o status recalculado pelos pagamentos, e as parcelas 2 e 3 são criadas pendentes

#### Scenario: Recorrente com mês pago tem o início antecipado
- **WHEN** uma recorrente começa em 2026-10, tem outubro pago, e a pessoa muda o mês de início para 2026-08
- **THEN** agosto e setembro são criados pendentes e outubro continua pago, com o valor previsto que tinha

#### Scenario: Parcelada com parcela paga ganha mais parcelas
- **WHEN** uma parcelada fora do crédito de 3 parcelas tem a 1ª paga e a pessoa muda para 5 parcelas com o mesmo total
- **THEN** a parcela 1 continua paga com o mesmo pagamento, o valor previsto dela passa a ser o da nova divisão, e o status é recalculado (parcial, se o pago ficar abaixo do previsto)

### Requirement: Onde cada ocorrência paga vai parar
O lugar equivalente na sequência nova SHALL ser decidido por uma regra pura, compartilhada entre servidor e interface:
- **de parcelada para parcelada:** a parcela de mesmo número;
- **para compra única:** a única ocorrência da compra, se houver no máximo uma ocorrência paga;
- **nos demais casos:** a ocorrência do mesmo mês. Para recorrente, um mês entre o mês de início e o fim, se houver. Para parcelada, a parcela que vence no mesmo mês.

Duas ocorrências pagas SHALL NOT ir para o mesmo lugar.

#### Scenario: Recorrente com um mês pago vira única
- **WHEN** uma recorrente tem só outubro pago e a pessoa a transforma em despesa única
- **THEN** a ocorrência de outubro, com seu pagamento, vira a única, no mês definido pela data da compra única

#### Scenario: Única paga vira parcelada que começa antes
- **WHEN** uma única paga em outubro de 2026 vira parcelada de 3 parcelas com a 1ª em 2026-09-10
- **THEN** a ocorrência paga vira a parcela 2/3, que vence em outubro

### Requirement: Recusa quando o pagamento não tem para onde ir
A edição estrutural SHALL ser recusada com 409 `payments_not_movable`, sem mudar nada, quando houver pagamento e:
- o tipo mudar entre despesa e entrada: "Este lançamento já tem pagamento. Para trocar entre despesa e entrada, desfaça o pagamento antes ou cadastre de novo.";
- o lançamento passar para o crédito: "Este lançamento já tem pagamento, e no crédito tudo passa pela fatura. Desfaça o pagamento antes ou cadastre de novo.";
- for para compra única com mais de uma ocorrência paga: "Este lançamento tem mais de um mês pago e não cabe numa compra única. Desfaça os pagamentos antes ou cadastre de novo.";
- um mês pago ficar antes do novo mês de início da recorrente: "O mês pago de <mês/ano> ficaria antes do novo mês de início. Comece até <mês/ano> ou desfaça o pagamento.";
- um mês pago ficar depois do fim da recorrente: "O mês pago de <mês/ano> ficaria depois do fim da recorrência. Desfaça o pagamento antes ou cadastre de novo.";
- uma parcela paga deixar de existir: "A parcela <n> já foi paga e deixaria de existir. Mantenha pelo menos <n> parcelas ou desfaça o pagamento.";
- um mês pago ficar sem parcela que vença no mesmo mês: "O pagamento de <mês/ano> não teria parcela no mesmo mês. Ajuste a data da 1ª parcela ou desfaça o pagamento.";
- duas ocorrências pagas caírem no mesmo lugar: "Dois pagamentos cairiam no mesmo mês. Desfaça um deles antes ou cadastre de novo.".

A recusa por parte numa fatura já paga SHALL continuar como antes, com a mensagem atual.

#### Scenario: Início depois do mês pago
- **WHEN** uma única paga em outubro de 2026 vira recorrente com mês de início novembro de 2026
- **THEN** o servidor responde 409 `payments_not_movable` com "O mês pago de out/2026 ficaria antes do novo mês de início. Comece até out/2026 ou desfaça o pagamento." e nada muda

#### Scenario: Menos parcelas que a parcela paga
- **WHEN** uma parcelada de 5 parcelas tem a 4ª paga e a pessoa muda para 3 parcelas
- **THEN** o servidor responde 409 `payments_not_movable` com "A parcela 4 já foi paga e deixaria de existir. Mantenha pelo menos 4 parcelas ou desfaça o pagamento."

#### Scenario: Paga e passando para o crédito
- **WHEN** uma despesa única paga no pix é editada para o método Crédito
- **THEN** o servidor responde 409 `payments_not_movable` e nada muda

#### Scenario: Despesa paga vira entrada
- **WHEN** uma despesa única paga é editada para entrada
- **THEN** o servidor responde 409 `payments_not_movable` e nada muda

### Requirement: Formulário avisa antes de salvar
Numa mudança estrutural, o formulário de edição SHALL aplicar a mesma regra aos pagamentos que conhece e mostrar o resultado antes de salvar:
- se algum pagamento não tiver para onde ir, um aviso de perigo com a mesma mensagem do servidor;
- se houver pagamentos e todos couberem, um aviso informativo de que a mudança recalcula os meses e os pagamentos continuam nos meses equivalentes;
- sem pagamentos, o aviso atual.

O servidor SHALL continuar sendo a fonte da verdade. Meses pagos que o formulário não carrega (meses futuros pagos adiantado) são conferidos só no servidor.

#### Scenario: Aviso ao transformar única paga em recorrente
- **WHEN** a pessoa abre uma única paga em outubro e escolhe "Todo mês" com início em outubro
- **THEN** o formulário mostra "Essa mudança recalcula os meses deste lançamento. Os pagamentos já feitos continuam nos meses equivalentes." e deixa salvar

#### Scenario: Aviso ao escolher início depois do mês pago
- **WHEN** na mesma edição a pessoa muda o início para novembro
- **THEN** o formulário mostra, como perigo, "O mês pago de out/2026 ficaria antes do novo mês de início. Comece até out/2026 ou desfaça o pagamento."
