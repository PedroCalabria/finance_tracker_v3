# Registro de decisões (ADRs)

Cada decisão de arquitetura ou de regra de negócio tomada na implementação fica num arquivo próprio, com o contexto, a decisão e as consequências. A especificação original ("Dashboard Financeiro Familiar — Especificação") é a fonte das regras; estes arquivos registram **como** elas foram implementadas e **onde** a implementação se afastou dela, com o motivo.

Ao mudar uma regra, atualize o ADR correspondente (ou crie um novo que o substitua) no mesmo commit.

| # | Decisão | Etapas |
| --- | --- | --- |
| [0001](0001-repositorio-e-ferramentas.md) | Monorepo npm workspaces, TypeScript, testes contra Postgres real, entrega do git por bundle | todas |
| [0002](0002-stack-e-contratos-da-api.md) | React + Vite, Fastify, Drizzle, zod compartilhado, formato de erro, versão/409 | 1 |
| [0003](0003-autenticacao.md) | JWT curto + refresh opaco rotativo, argon2id, email obrigatório | 1 |
| [0004](0004-modelo-de-dados-e-lancamentos.md) | Carteiras, itens e ocorrências, projeções, atrasos, cards, "já foi pago" | 1, 2, 3, 4, 6 |
| [0005](0005-cartoes-e-faturas.md) | Fatura pelo mês de vencimento, fechamento, ajuste, saldo transferido | 5 |
| [0006](0006-comprovantes.md) | Formatos, limites, EXIF, AES-256-GCM, proxy na API | 4 |
| [0007](0007-notificacoes.md) | Worker pg-boss horário, resumo diário idempotente, calendário bancário calculado | 7 |
| [0008](0008-infraestrutura-e-operacao.md) | Uma imagem Docker, Compose na VPS, backup cifrado com retenção | 8 |
| [0009](0009-interface.md) | Design system no código, tabela responsiva, cache de dados, tema | 3, 6 |
| [0010](0010-importacao.md) | Importação de extrato e fatura (PDF do BB e OFX), leitura local, prévia assinada, conciliação, impressão digital | fase 2 |
| [0011](0011-dividas.md) | Dívidas: módulo isolado, saldo por âncora, taxa em milionésimos, simulação mês a mês, avalanche/bola de neve/minha ordem | fase 2 |
| [0012](0012-investimentos.md) | Investimentos em caixinhas: módulo isolado, CDI da carteira, lotes por aporte, IR/IOF regressivos, projeção; balanço do mês desconta o que tem destino | fase 2 |

O estado de cada etapa e as pendências estão em [`../PROGRESS.md`](../PROGRESS.md).
