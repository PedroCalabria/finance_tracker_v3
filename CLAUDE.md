# Guia para quem continuar o desenvolvimento (pessoas e agentes)

Leia antes de mudar código: `docs/PROGRESS.md` (estado) e `docs/decisions/` (o porquê de cada regra).

## Convenções
- Textos de interface, mensagens de erro, commits e documentação em **português**; código (nomes) em inglês.
- **Dinheiro sempre em centavos inteiros.** Datas `YYYY-MM-DD` e meses `YYYY-MM` como string; nunca `new Date()` para datas civis no domínio.
- Regra de negócio pura vai em `packages/shared` (com teste unitário). Regra que precisa do banco vai em `apps/server/src/domain` (com teste de integração em `apps/server/test`).
- Toda rota financeira fica sob `/api/wallets/:walletId` e autoriza por **membro da carteira**.
- Erros de domínio: `AppError` com código estável e mensagem pronta para a pessoa (`apps/server/src/http/errors.ts`).
- Interface: só classes do design system (`ff-*`) e tokens; `app.css` complementa layout. Não use cores literais.
- Mudou o schema? `npm run db:generate` e commite a migração SQL gerada em `apps/server/drizzle/`.
- Mudou uma regra? Atualize o ADR correspondente no mesmo commit.

## Comandos
`npm run dev` · `npm test` (precisa de Postgres; ver README) · `npm run typecheck` · `npm run build`.

## Armadilhas conhecidas
- Dentro de uma transação Drizzle a conexão é uma só: não faça `Promise.all` de consultas com `tx`.
- O Drizzle embrulha erros do Postgres em `cause` (ver `isUniqueViolation` em `domain/catalog.ts`).
- Recorrentes do futuro são **projeções** (`p_<itemId>_<mês>`): qualquer escrita deve passar por `materializeProjection` antes.
- Itens no crédito não têm pagamento próprio: tudo passa pela fatura.
