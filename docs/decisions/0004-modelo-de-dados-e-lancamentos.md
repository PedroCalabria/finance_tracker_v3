# 0004 — Modelo de dados e regras de lançamentos

**Status:** aceita · 03/11/2026 · código: `apps/server/src/db/schema.ts`, `apps/server/src/domain/*`

## Modelo
- **Carteira (`wallets`) é dona de todo dado financeiro**; `wallet_members` liga usuários (papel `owner`/`editor`). A autorização confere "é membro da carteira da URL", nunca "é dono do registro". Hoje cada pessoa tem só a carteira pessoal; a familiar entra sem migração de dados.
- **Item (`items`) = a regra; ocorrência (`occurrences`) = um mês concreto.** As linhas da tabela são ocorrências.
- Dinheiro em **centavos inteiros**; datas em `date` (lidas como string, sem `Date`); meses em `char(7)`.
- `created_by` em itens e `paid_by` em pagamentos já gravados: "quem pagou o quê" da carteira familiar está pronto.
- Exclusão lógica (`deleted_at`/`archived_at`); `version` para 409 em conflito.

## Regras implementadas
| Regra | Implementação |
| --- | --- |
| Mês da ocorrência | Fora do crédito: mês da "Data p/ pagamento"; sem ela, mês da "Data" do cadastro. Crédito: mês do vencimento da fatura (ADR-0005). |
| Parcelas | Total ÷ N em centavos, sobra na última (`splitInstallments`). Fora do crédito, mesmo dia nos meses seguintes (dia 31 → último dia do mês). Todas gravadas no cadastro. |
| Recorrentes | Mensais, sem fim. **Gravadas até o mês atual** na primeira leitura do mês (`ensureMaterialized`, idempotente); **meses futuros são projeções** com id `p_<itemId>_<YYYY-MM>`, gravadas quando alguém edita ou paga. Assim a regra pode mudar sem reescrever o futuro. |
| Valor da recorrente | Fixo: valor da regra. Variável ("o valor varia todo mês"): último valor **pago**; sem pagamento ainda, o da regra. |
| Mudar valor de um mês | Muda a regra; meses seguintes já gravados, pendentes e sem pagamento acompanham; meses anteriores ficam. O valor **pago** nunca altera meses seguintes. |
| Status gravado | `pending`/`partial`/`paid`/`canceled`, recalculado da soma dos pagamentos. "Quitado com desconto" marca pago abaixo do previsto. |
| Atrasado | Calculado: pendente/parcial de mês anterior ao atual (fora do crédito). Aparece no mês atual, primeiro na lista, com "Atrasado (out)". Crédito atrasado aparece pela **fatura** (bloco de faturas), não linha a linha. |
| "Já foi pago?" | Padrão na interface: Sim para compra única em pix/débito/dinheiro/transferência, sem data p/ pagamento e com data até hoje; Não no resto. Ao gravar com Sim: única é paga na data informada; parcelas/meses são pagos só os que já venceram, na data do vencimento. Crédito não pergunta. |
| Pagamento menor | Exige escolher **desconto** ou **parcial** (`settlement_required`). |
| Várias parcelas | `payNext: N` paga esta e as N seguintes em aberto, cada uma pelo seu restante, mesmo `group_id` (os comprovantes ficam no grupo). O total enviado precisa bater. |
| Cancelar compra | Parcelas futuras pendentes e sem pagamento → `canceled`; pagas ficam. Em fatura já paga não cancela. |
| Encerrar recorrente | `end_month`; ocorrências seguintes sem pagamento são apagadas (eram só agendadas). |
| Excluir item | Lógico; bloqueado se houver parcela numa fatura já paga (sugere cancelar). |
| Cards do mês | Calculados no servidor (`domain/summary.ts`): pago/recebido = pagamentos das ocorrências do mês fora do crédito + pagamentos das faturas do mês; a pagar = restante das ocorrências + saldo das faturas abertas; no mês atual, soma os atrasados e mostra "em atraso". Balanço realizado = recebido − pago; previsto = (recebido + a receber) − (pago + a pagar). Sem saldo acumulado. |
| Navegação | Do primeiro mês com dados até **6 meses à frente** ou a última parcela, o que for mais longe. |

## Desvios e acréscimos à especificação
- **Métodos:** além de crédito, débito, pix e boleto, entraram **Transferência** e **Dinheiro**, necessários para entradas (salário por TED) e mesadas. Crédito só para despesas.
- **Categorias iniciais** no cadastro (Casa, Alimentação, Transporte, Saúde, Educação, Lazer, Família, Outros; Salário, Outros) para não começar do zero. Continuam editáveis.
- **Projeção na subgrid:** a subgrid de recorrentes mostra passado, mês atual e o próximo mês previsto.
- **Itens de sistema** ("Ajuste da fatura", "Saldo restante…") não podem ser editados nem excluídos diretamente; somem ao desfazer o pagamento da fatura.
