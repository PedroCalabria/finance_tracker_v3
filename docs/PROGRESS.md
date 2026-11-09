# Progresso da implementação

Atualizado em 09/11/2026. Fase 1 da especificação implementada; o que falta para colocar no ar depende de contas e chaves que só o dono do projeto pode criar.

## Etapas da fase 1
| # | Etapa | Estado | Onde |
| --- | --- | --- | --- |
| 1 | Base: monorepo, Docker Compose, Postgres, autenticação, carteira pessoal | Pronta | `apps/server/src/{auth,db,http}`, ADR-0001–0003 |
| 2 | Cadastros: categorias, contas e cartões | Pronta | `domain/catalog.ts`, `pages/CategoriesPage`, `pages/AccountsPage` |
| 3 | Itens e ocorrências, projeções, tabela, filtros, ordenação, cards | Pronta | `domain/{items,occurrences,projections,summary}.ts`, `month/` |
| 4 | Pagamentos e comprovantes (parcial, desconto, várias parcelas, R2 cifrado) | Pronta | `domain/{payments,attachments}.ts`, `month/PayModal` |
| 5 | Faturas: compra × fechamento, pagar, ajuste, saldo transferido, mover | Pronta | `domain/invoices.ts`, `month/InvoicesBlock` |
| 6 | Meses e atrasos, layout de celular | Pronta | `month/MonthPage`, `styles/app.css` |
| 7 | Notificações: worker horário, resumo diário, calendário bancário | Pronta | `jobs/daily-summary.ts`, `main-worker.ts` |
| 8 | Operação: imagem, Compose, backup cifrado, alerta, restauração | Pronta (scripts) | `Dockerfile`, `docker-compose.yml`, `scripts/`, `docs/operacao.md` |

## Fase 2
| Etapa | Estado | Onde |
| --- | --- | --- |
| Importação de extrato e fatura com conciliação: extrato e fatura Ourocard do BB em PDF, OFX de conta | Pronta | `packages/shared/src/imports/`, `apps/server/src/{imports,domain/imports}/`, `pages/ImportPage`, ADR-0010 |

## Verificação
- 85 testes unitários (`packages/shared`) + 143 de integração (`apps/server/test`): mês do gasto (inclusive o backfill da migração), pessoas e reembolso de gasto de terceiros, parcelas de meses anteriores (inclusive faturas passadas), migrações simultâneas (API e worker), leitores de importação (fixtures anonimizadas), autenticação (inclusive renovação sem o cookie de acesso e corrida entre abas), cadastros, edição de lançamentos (inclusive estrutural com meses pagos), parcelas, recorrentes e projeções, exclusão de recorrente por alcance, importação e conciliação (extrato, fatura, senha, reimportação), pagamentos, faturas, resumo, concorrência, comprovantes (EXIF, cifragem, tipos), avisos (horário, fuso, dia útil, feriado, idempotência).
- Roteiro completo no navegador em 1440px, 1920px, 900px e celular, claro e escuro.
- Passos do Dockerfile reproduzidos numa cópia limpa (o ambiente de desenvolvimento não tinha Docker).

## Para colocar no ar (com o dono do projeto)
- [ ] Registrar o domínio e configurar DNS na Cloudflare (`docs/operacao.md` §1)
- [ ] Criar conta no Resend e validar `avisos.<domínio>` (SPF, DKIM, DMARC)
- [ ] Criar os buckets R2 e as chaves
- [ ] Gerar `JWT_SECRET`, `ATTACHMENTS_KEY` e a chave do age; guardar no gerenciador de senhas
- [ ] Primeiro `docker compose build` na VPS (validação final da imagem) e site no CloudPanel
- [ ] Agendar o backup no cron e fazer o primeiro teste de restauração
- [ ] Sincronizar `content-max = 1440px` de volta no artifact Design System (ADR-0009)

## Fora da fase 1 (decidido na especificação)
- Fase 2: importação de extrato com conciliação — **entregue** para BB (PDF) e OFX (ADR-0010); CSV fica para depois.
- Futuro: carteira familiar compartilhada (modelo pronto: `wallet_members`, `paid_by`, `version`), histórico de alterações, 2FA, WhatsApp.

## Ajustes depois da fase 1 (04/11/2026)
- Edição completa de lançamentos (`PUT /items/:id`, ADR-0004) com o formulário do cadastro.
- "+ Nova conta"/"+ Novo cartão" no seletor do lançamento; entradas sem "Data p/ pagamento" (a Data é a do recebimento); "Voltar para o mês atual" à esquerda do seletor (ADR-0009).
- **Sessão caindo depois de ~15 min (corrigido):** o cookie `ff_access` vence com o JWT, então a API respondia `unauthorized` e o cliente, que só renovava em `token_expired`, mandava para o login. Agora o cliente renova em qualquer 401 fora de `/api/auth`, repete uma vez mesmo se a renovação falhar e serializa a renovação entre abas (Web Locks); o servidor responde `refresh_superseded` na corrida entre abas **sem apagar os cookies** da aba vencedora (ADR-0003, ADR-0009).
- **Recorrente com "Mês de início" + dia:** "Dia para o pagamento" (opcional), "Dia do recebimento" ou "Dia da cobrança"; a API recebe `startMonth`/`day` e confere no servidor. Mudar o dia fora do crédito vale do mês aberto em diante; mudar o mês de início ou o dia da cobrança recria os meses. Seletor de mês próprio (`MonthInput`), porque `<input type="month">` falha no Safari (ADR-0004, ADR-0009).
- **Parcelada fora do crédito com uma só data**, a da 1ª parcela (também a `entry_date`); na edição, mudar a data de uma parcela recalcula todas (ADR-0004).
- **Excluir recorrente pergunta o alcance:** só este mês (`POST /occurrences/:id/cancel`, inclusive nos meses previstos), este e os próximos (`POST /items/:id/end` com `occurrenceId`, substitui "Encerrar a partir deste mês") e toda a recorrência; recusas com `month_has_payment`, `month_in_paid_invoice`, `later_months_paid` e `not_recurring` (ADR-0004, ADR-0009).
- Observado nos testes, não corrigido: pagar uma fatura não grava as cobranças recorrentes **previstas** dela; a linha continua "Prevista" com status de fatura em aberto até alguém mexer no mês.
- O teste `a limpeza apaga órfãos com mais de 24 h` depende da data real (cria o comprovante com o relógio do sistema e simula 05/11 15h): falha a partir de 04/11/2026. Precisa usar o relógio do teste também na gravação.

## Ajustes de 06/11/2026
- **Edição estrutural preserva os meses pagos:** transformar uma única paga (por exemplo, importada do extrato) em recorrente ou parcelada, mudar o mês de início, a data de uma parcela ou o nº de parcelas não é mais recusado só por ter pagamento. A ocorrência paga fica, com pagamentos, comprovantes e vínculo do extrato, e vai para o lugar equivalente da sequência nova. A recusa (`payments_not_movable`) só vale quando não há lugar, com a mensagem dizendo o porquê. O formulário avisa antes de salvar com a mesma regra (`paidTargets`, ADR-0004).

## Ajustes de 08/11/2026
- **Pessoas e responsável:** cadastro de pessoas por carteira (aba "Pessoas" em Categorias); cada lançamento tem um responsável ("Eu" por padrão), com coluna "Responsável" na tabela (ADR-0004, ADR-0009).
- **Gasto de outra pessoa:** no cadastro de despesa, o checkbox cria na mesma transação a entrada de reembolso ("Gasto de terceiros"), com as datas de quando a despesa é paga (no crédito, os vencimentos das faturas). Vinculada só para exibir e excluir junto (ADR-0004).
- **Compra parcelada antiga:** "As parcelas de meses anteriores já foram pagas?" (padrão Sim) quita as parcelas de competência anterior ao mês atual; no crédito, paga as faturas passadas que só têm essa compra (ADR-0004, ADR-0005).
- **Formulário:** parcelada abre no Crédito; número de parcelas com setas (`StepperInput`).
- **Cards do mês:** o previsto em destaque e o realizado embaixo (`forecastCents` no resumo).

## Ajustes de 09/11/2026
- **Gastos no mês da compra:** compras no crédito passam a aparecer e contar no mês em que foram feitas (mês do gasto, `charge_month`), não no mês da fatura; a fatura continua pelo vencimento e o bloco mostra o período das compras. Recorrentes no crédito são gravadas quando a cobrança chega. Cards: gastos = consumo do mês; "Na conta até agora" = caixa (inclui faturas pagas). Reembolso de terceiros no mesmo mês do gasto. Backfill dos lançamentos existentes na migração `0003` (ADR-0004, ADR-0005, ADR-0009).

## Observações para as próximas etapas
- **Carteira familiar:** criar `POST /wallets`, convites (`/wallets/:id/invites`, `/invites/:token/accept`) e um seletor de carteira na interface; as rotas financeiras já são por carteira. O resumo diário já percorre todas as carteiras da pessoa.
- **Importação (ADR-0010):** banco novo = leitor novo em `packages/shared/src/imports/readers/` + entrada em `READERS` + fixture anonimizada (`npx tsx scripts/anonymize-import-fixture.ts <pdf> <saida.json>`, que só sabe anonimizar BB; para outro banco, adaptar). PDFs reais ficam em `docs/bank-docs-examples/` (fora do git e da imagem). Pendente: CSV, outros bancos, OFX de cartão, desfazer um lote, tela de histórico das importações e mostrar a numeração original das parcelas importadas.
- **Telas não feitas por não estarem no escopo:** troca de email/senha logada, exclusão de conta.
