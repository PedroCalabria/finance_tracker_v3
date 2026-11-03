# 0003 — Autenticação

**Status:** aceita · 03/11/2026

## Decisão
- **Access token:** JWT HS256 (`jose`), 15 minutos, em cookie `ff_access` httpOnly, `SameSite=Lax`, `Secure` em produção. Carrega `sub` (usuário) e `sid` (sessão).
- **Refresh token:** 32 bytes aleatórios, opaco, guardado só como SHA-256 na tabela `sessions`; cookie `ff_refresh` restrito ao caminho `/api/auth`. Validade de **30 dias**, renovada a cada uso.
- **Rotação:** cada `/auth/refresh` marca o token como usado e emite outro na mesma `family_id`. Reuso de um token já rotacionado **depois de 30 s** revoga a família inteira (roubo provável). Dentro de 30 s é tratado como corrida entre abas: responde 401 sem revogar.
- **Revogação imediata:** toda requisição confere se a sessão (`sid`) ainda está ativa — "Sair de todos os aparelhos" derruba também os access tokens já emitidos.
- **Senhas:** argon2id (`@node-rs/argon2`, m=19 MiB, t=2). No login com email inexistente, compara contra um hash fictício para não vazar, pelo tempo, quais emails existem.
- **Cadastro aberto com email obrigatório:** só entra quem confirmou o email (link de 24 h, uso único). Login sem confirmação responde `email_not_verified` e a interface oferece reenviar.
- **Recuperação de senha:** link de 1 h, uso único; resposta sempre genérica; redefinir confirma o email e revoga todas as sessões.
- **Rate limit:** 10/min por IP em login, cadastro e rotas que enviam email; 300/min no resto. Desligável só para testes (`RATE_LIMIT=off`).
- Ao se cadastrar, a pessoa ganha a carteira "Pessoal" (dona), configuração de avisos padrão e categorias iniciais (ADR-0004).

## Desvio da especificação
A especificação sugere "uma biblioteca de autenticação madura". Optou-se por **primitivas maduras** (jose, argon2, rate-limit, cookie) e ~200 linhas próprias em `apps/server/src/auth`, porque o fluxo pedido (JWT + refresh rotativo com detecção de reuso) não é o padrão das bibliotecas populares, que usam sessão em cookie. Os testes de `apps/server/test/auth.test.ts` cobrem rotação, reuso, revogação e redefinição.

## Fora da fase 1
2FA, troca de email, exclusão de conta pela interface.
