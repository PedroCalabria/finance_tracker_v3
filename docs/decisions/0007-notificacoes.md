# 0007 — Notificações por email

**Status:** aceita · 03/11/2026 · código: `apps/server/src/jobs/daily-summary.ts`, `apps/server/src/main-worker.ts`

## Decisão
- **Worker separado** (`main-worker`, mesma imagem da API) com **pg-boss 10** sobre o próprio Postgres (schema `pgboss`), sem Redis. Jobs:
  - `daily-summaries` — **de hora em hora** (`0 * * * *` UTC);
  - `purge-attachments` — diário às 06:30 UTC.
  Ambos com 3 tentativas e espera crescente.
- **Quem recebe e quando:** a cada rodada, envia para quem tem avisos ligados, email confirmado e cujo **horário escolhido** coincide com a hora atual **no fuso da pessoa** (`users.timezone`, padrão America/Sao_Paulo).
- **Um email por pessoa por dia:** antes de enviar, reserva `(usuário, dia, 'daily_summary')` em `notification_log` (chave primária). Rodada repetida não reenvia; se o envio falhar, a reserva é desfeita para a próxima tentativa.
- **O que entra:** ocorrências pendentes/parciais com data p/ pagamento, faturas abertas com saldo e **recorrentes do mês seguinte ainda projetadas** (ex.: vencimento dia 1º). Cada vencimento avisa:
  - **no dia** — ou no dia útil anterior, se cair em fim de semana/feriado;
  - **N dias úteis antes** (padrão 1, configurável de 0 a 3 na interface).
- **Seções do email:** "Vencem hoje", "Vencem no próximo dia útil", e — para entradas prometidas — "Hoje você deve receber" e "Você deve receber em breve". **Sem itens, sem email.** O botão leva a `/?mes=YYYY-MM`.
- **Calendário bancário calculado em código** (`packages/shared/src/business-days.ts`): fins de semana, feriados nacionais fixos (inclui 20/11), segunda e terça de Carnaval e Sexta-feira Santa (pela data da Páscoa).
- **Envio:** Resend pela API HTTP (sem SDK). `EMAIL_DRIVER=console` em desenvolvimento mostra os emails (com links) no terminal.

## Desvio da especificação
A especificação prevê uma tabela `holidays`. O calendário é **calculado** (não há o que atualizar todo ano). Se um dia precisar de feriados estaduais/municipais, criar a tabela e somá-la em `bankHolidays()`.

## Futuro
WhatsApp via n8n consumindo um endpoint de "resumo do dia" que reaproveite `collectDue()`.
