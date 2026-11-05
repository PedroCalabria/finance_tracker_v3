# Progresso da implementação

Atualizado em 05/11/2026. Fase 1 da especificação implementada; o que falta para colocar no ar depende de contas e chaves que só o dono do projeto pode criar.

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
- 60 testes unitários (`packages/shared`) + 97 de integração (`apps/server/test`): migrações simultâneas (API e worker), leitores de importação (fixtures anonimizadas), autenticação (inclusive renovação sem o cookie de acesso e corrida entre abas), cadastros, edição de lançamentos, parcelas, recorrentes e projeções, exclusão de recorrente por alcance, importação e conciliação (extrato, fatura, senha, reimportação), pagamentos, faturas, resumo, concorrência, comprovantes (EXIF, cifragem, tipos), avisos (horário, fuso, dia útil, feriado, idempotência).
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

## Observações para as próximas etapas
- **Carteira familiar:** criar `POST /wallets`, convites (`/wallets/:id/invites`, `/invites/:token/accept`) e um seletor de carteira na interface; as rotas financeiras já são por carteira. O resumo diário já percorre todas as carteiras da pessoa.
- **Importação (ADR-0010):** banco novo = leitor novo em `packages/shared/src/imports/readers/` + entrada em `READERS` + fixture anonimizada (`npx tsx scripts/anonymize-import-fixture.ts <pdf> <saida.json>`, que só sabe anonimizar BB; para outro banco, adaptar). PDFs reais ficam em `docs/bank-docs-examples/` (fora do git e da imagem). Pendente: CSV, outros bancos, OFX de cartão, desfazer um lote, tela de histórico das importações e mostrar a numeração original das parcelas importadas.
- **Telas não feitas por não estarem no escopo:** troca de email/senha logada, exclusão de conta.
