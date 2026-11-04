# Finanças da Família

Dashboard para a família acompanhar despesas, entradas, parcelas, recorrências e faturas de cartão do mês, com resumo diário por email dos vencimentos.

- **Especificação:** documento "Dashboard Financeiro Familiar — Especificação" (Claude Docs).
- **Decisões de implementação:** [`docs/decisions/`](docs/decisions/README.md).
- **Estado e próximos passos:** [`docs/PROGRESS.md`](docs/PROGRESS.md).
- **Deploy, backup e restauração:** [`docs/operacao.md`](docs/operacao.md).

## Estrutura
```
apps/server            API Fastify + worker (pg-boss) + migrações (Drizzle)
apps/web               Interface React + Vite
packages/shared        Regras puras, schemas zod e tipos da API (usado pelos dois lados)
packages/design-system tokens.json + components.css do design system
docs/decisions         ADRs
scripts                tokens, backup, restauração, setup do git
```

## Rodando no computador (Windows, macOS ou Linux)
Requisitos: **Node 22+** e um **PostgreSQL 16** (o jeito mais fácil é Docker).

```bash
npm install
cp .env.example .env          # no Windows: copy .env.example .env
# gere JWT_SECRET e ATTACHMENTS_KEY com os comandos indicados no próprio .env.example

docker compose up -d db       # sobe só o Postgres em 127.0.0.1:5432
# Se a 5432 já estiver ocupada (ex.: Postgres instalado no Windows), ponha DB_PORT=5433
# no .env e use a mesma porta no DATABASE_URL e no TEST_DATABASE_URL.
npm run db:migrate
npm run dev                   # API :3000 + worker + interface :5173
```
Abra http://localhost:5173, crie a conta e **copie o link de confirmação que aparece no terminal** (em desenvolvimento os emails não são enviados, só mostrados).

### Testes
```bash
docker compose exec db psql -U financas -c "create database financas_test"
TEST_DATABASE_URL=postgres://financas:financas@localhost:5432/financas_test npm test
npm run typecheck
```
São 18 testes de regras puras e 50 de integração (API inteira contra o Postgres, com o relógio fixo em 03/11/2026).

## Comandos
| Comando | O que faz |
| --- | --- |
| `npm run dev` | API, worker e interface com recarga automática |
| `npm run build` | Gera `apps/web/dist` e `apps/server/dist` |
| `npm run db:generate` | Cria uma migração SQL a partir de mudanças em `apps/server/src/db/schema.ts` |
| `npm run db:migrate` | Aplica as migrações |
| `npm run tokens` | Regenera `tokens.css` a partir de `packages/design-system/tokens.json` |
| `npm test` / `npm run typecheck` | Testes / checagem de tipos |
