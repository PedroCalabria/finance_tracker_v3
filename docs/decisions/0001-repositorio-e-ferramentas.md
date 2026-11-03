# 0001 — Repositório e ferramentas

**Status:** aceita · 03/11/2026

## Contexto
Projeto pessoal, uma pessoa desenvolvendo, código em TypeScript nos dois lados. A especificação pede monólito na VPS com front, API, worker e tipos compartilhados.

## Decisão
- **Monorepo com npm workspaces** (sem pnpm/turbo, para funcionar igual no Windows e no Linux sem instalar nada além do Node):
  - `apps/server` — API Fastify, worker e migrações (um pacote, três pontos de entrada: `main-api`, `main-worker`, `main-migrate`).
  - `apps/web` — interface React (Vite).
  - `packages/shared` — regras puras (dinheiro, datas, dias úteis, faturas), schemas zod e tipos das respostas. É TypeScript puro, consumido direto pelo código-fonte (sem build próprio); o `tsup` embute no bundle do servidor e o Vite na interface.
  - `packages/design-system` — `tokens.json` e `components.css` copiados do artifact Design System.
- **Node 22+**, versões das dependências fixadas (exatas) no `package.json` e no lockfile.
- **Testes:** Vitest. As regras puras têm testes unitários (`packages/shared`). A API tem testes de integração que sobem a aplicação inteira contra um **Postgres real** (`financas_test`), com relógio fixo em 03/11/2026 — nada de mock de banco, porque as regras dependem de SQL (índices únicos, transações).
- **Git:** histórico por etapa, mensagens em português. O ambiente do Claude não pode gravar a pasta `.git` no computador do usuário; o histórico é entregue em `financas.bundle` e recriado com `scripts/setup-git.ps1` (um comando).

## Consequências
- `npm test` exige um Postgres acessível em `TEST_DATABASE_URL` (padrão `postgres://postgres@localhost:5432/financas_test`). Com Docker: `docker compose up -d db` e criar o banco `financas_test`.
- Um único `package-lock.json` na raiz.
