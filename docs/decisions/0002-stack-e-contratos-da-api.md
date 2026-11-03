# 0002 — Stack e contratos da API

**Status:** aceita · 03/11/2026

## Decisão
| Camada | Escolha | Por quê |
| --- | --- | --- |
| Interface | React 18 + Vite 7, React Router 6, TanStack Query 5 | SPA autenticada; sem SEO, SSR não traz ganho |
| API | Fastify 5 | Rápida, plugins oficiais para cookie, rate limit, multipart e estáticos |
| Banco | PostgreSQL 16 + Drizzle ORM 0.44 (+ drizzle-kit para migrações SQL versionadas) | SQL explícito, tipos gerados do schema |
| Validação | zod 3 em `packages/shared`, usado na API e na interface | Um contrato só |
| Fila/agendador | pg-boss 10 (ver ADR-0007) | Sem Redis |

### Contratos
- **REST sob `/api/wallets/:walletId/...`** para todo dado financeiro (mudar para carteira familiar não muda endpoint). Lista completa no código: `apps/server/src/http/routes/wallet.ts`.
- **Erros** sempre `{"error": {"code", "message", "fields?"}}`, mensagem em português pronta para mostrar. Códigos estáveis usados pela interface: `validation`, `token_expired`, `email_not_verified`, `invalid_credentials`, `settlement_required`, `credit_item`, `invoice_closed`, `conflict`, `rate_limited`.
- **Concorrência:** tabelas editáveis têm `version`; o `PATCH` de ocorrência aceita `version` e devolve **409** se mudou. Pronto para a edição a dois da carteira familiar.
- **Datas** trafegam como `YYYY-MM-DD` e meses como `YYYY-MM`; **dinheiro** em centavos inteiros.
- Em produção a própria API serve a interface compilada (`WEB_DIST`), com fallback de SPA.

## Desvios da especificação
- `PATCH /invoice-payments/:id` só altera a **data**. Para mudar o valor de um pagamento de fatura: desfazer e pagar de novo — valor muda o ajuste e o saldo transferido, e refazer é mais seguro que recalcular.
- Comprovantes podem ser enviados **antes** do pagamento (`POST /attachments`, devolvendo um id) e ligados no `POST .../payments` via `attachmentIds`. As rotas `POST /payments/:id/attachments` e `/invoice-payments/:id/attachments` da especificação também existem, para anexar depois.
- Rota extra `GET /invoice-preview?account=&date=` para o aviso "Vai para a fatura de…" no cadastro.
