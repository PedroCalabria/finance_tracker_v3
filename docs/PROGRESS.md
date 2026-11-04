# Progresso da implementação

Atualizado em 04/11/2026. Fase 1 da especificação implementada; o que falta para colocar no ar depende de contas e chaves que só o dono do projeto pode criar.

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

## Verificação
- 18 testes unitários (`packages/shared`) + 50 de integração (`apps/server/test`): autenticação, cadastros, edição de lançamentos, parcelas, recorrentes e projeções, pagamentos, faturas, resumo, concorrência, comprovantes (EXIF, cifragem, tipos), avisos (horário, fuso, dia útil, feriado, idempotência).
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
- Fase 2: importação de extrato OFX/CSV com tela de conciliação.
- Futuro: carteira familiar compartilhada (modelo pronto: `wallet_members`, `paid_by`, `version`), histórico de alterações, 2FA, WhatsApp.

## Ajustes depois da fase 1 (04/11/2026)
- Edição completa de lançamentos (`PUT /items/:id`, ADR-0004) com o formulário do cadastro.
- "+ Nova conta"/"+ Novo cartão" no seletor do lançamento; entradas sem "Data p/ pagamento" (a Data é a do recebimento); "Voltar para o mês atual" à esquerda do seletor (ADR-0009).
- O teste `a limpeza apaga órfãos com mais de 24 h` depende da data real (cria o comprovante com o relógio do sistema e simula 05/11 15h): falha a partir de 04/11/2026. Precisa usar o relógio do teste também na gravação.

## Observações para as próximas etapas
- **Carteira familiar:** criar `POST /wallets`, convites (`/wallets/:id/invites`, `/invites/:token/accept`) e um seletor de carteira na interface; as rotas financeiras já são por carteira. O resumo diário já percorre todas as carteiras da pessoa.
- **Importação (fase 2):** reutilizar `createItem` e `addPayment`; o pagamento de fatura no extrato deve casar com a fatura (`payInvoice`), nunca virar despesa.
- **Telas não feitas por não estarem no escopo:** troca de email/senha logada, exclusão de conta.
