# 0008 — Infraestrutura e operação

**Status:** aceita · 03/11/2026 · arquivos: `Dockerfile`, `docker-compose.yml`, `scripts/backup.sh`, `scripts/restore.sh`, `docs/operacao.md`

## Decisão
- **Uma imagem** (Node 22, Debian slim) com API, interface compilada e worker; o comando escolhe o papel. A API aplica as migrações ao subir (e o worker também, idempotente).
- **Docker Compose na VPS existente**: `db` (Postgres 16, volume próprio, porta só em `127.0.0.1`), `app` (porta `127.0.0.1:3000`) e `worker`, com limites de memória para conviver com os outros projetos. O **CloudPanel** faz o proxy HTTPS para `127.0.0.1:3000` (site do tipo "Reverse Proxy").
- `TRUST_PROXY=true` e cookies `Secure` em produção.
- **Comprovantes no Cloudflare R2** (bucket privado, chave com acesso só a ele).
- **Backup diário** (`scripts/backup.sh`, cron do host às 03:15): `pg_dump -Fc` → cifrado com **age** (chave pública na VPS, privada fora dela) → bucket **separado** no R2 via **rclone**; retenção de 7 diários, 4 semanais e 6 mensais; arquivo pequeno demais ou erro → email de alerta pelo Resend.
- **Restauração** (`scripts/restore.sh`) sempre num banco novo (`financas_restore`) para conferir sem tocar na produção. **Teste trimestral** obrigatório (roteiro em `docs/operacao.md`).
- **Domínio:** `.com.br` no Registro.br, DNS na Cloudflare; `financas.<domínio>` → VPS; `avisos.<domínio>` só para envio (SPF/DKIM do Resend, DMARC `p=none` → `quarantine`).

## Consequências
- A VPS é ponto único de falha (aceitável para uso familiar); dados recuperáveis pelo backup fora dela.
- A imagem **não foi construída no ambiente de desenvolvimento do Claude** (sem daemon Docker); os passos do Dockerfile foram reproduzidos numa cópia limpa (instalação, build, prune e execução da API e do worker só com os arquivos da imagem). O primeiro `docker compose build` na VPS é a validação final.
