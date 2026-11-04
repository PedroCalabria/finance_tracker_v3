# Operação: deploy, backup e restauração

Decisões em [ADR-0008](decisions/0008-infraestrutura-e-operacao.md).

## 1. Antes do primeiro deploy (uma vez)
1. **Domínio:** registrar um `.com.br` no Registro.br (renovação automática ligada) e apontar os nameservers para a Cloudflare.
2. **DNS (Cloudflare):** `financas` → IP da VPS (A). Para o email, adicionar no Resend o domínio `avisos.<seu-domínio>` e criar no DNS os registros SPF/DKIM que ele mostrar, mais `_dmarc.avisos` com `v=DMARC1; p=none; rua=mailto:<seu-email>`. Depois de 2 a 4 semanas sem problemas, trocar para `p=quarantine`.
3. **Cloudflare R2:** criar dois buckets privados, `financas-comprovantes` e `financas-backups`, e uma chave de API para cada um (a do backup, se possível, só com escrita).
4. **Chaves (guardar no gerenciador de senhas antes de usar):**
   - `JWT_SECRET`: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
   - `ATTACHMENTS_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` — **perdê-la = perder os comprovantes**.
   - Backup: `age-keygen -o financas-backup.key` **no seu computador**, fora da pasta do projeto. A linha "public key" vai para `BACKUP_AGE_RECIPIENT`; o arquivo `.key` **não vai para a VPS**. No Windows, instale antes com `winget install FiloSottile.age` e abra um terminal novo; no macOS, `brew install age`. Guarde o conteúdo do `.key` no gerenciador de senhas: sem ele, os backups não podem ser restaurados.

## 2. Deploy na VPS
```bash
sudo mkdir -p /opt/financas && cd /opt/financas
git clone <repositório> .          # ou copie os arquivos
cp .env.example .env && nano .env  # produção: ver lista abaixo
docker compose build
docker compose up -d
docker compose logs -f app         # "Server listening at http://0.0.0.0:3000"
```
`.env` de produção (além do exemplo): `NODE_ENV=production`, `APP_URL=https://financas.<domínio>`, `POSTGRES_PASSWORD=<forte>`, `STORAGE_DRIVER=s3` + `S3_*` do bucket de comprovantes, `EMAIL_DRIVER=resend`, `RESEND_API_KEY`, `EMAIL_FROM="Finanças da Família <avisos@avisos.<domínio>>"`, `BACKUP_AGE_RECIPIENT`, `BACKUP_ALERT_TO=<seu-email>`. Se a porta 3000 ou 5432 já estiver em uso por outro projeto, defina `APP_PORT`/`DB_PORT`.

**CloudPanel:** *Add Site → Create a Reverse Proxy*, domínio `financas.<domínio>`, URL `http://127.0.0.1:3000`; emitir o certificado Let's Encrypt.

**Atualizar:** `git pull && docker compose build && docker compose up -d` (as migrações rodam sozinhas ao subir).

## 3. Backup
Instalar no host: `sudo apt install age rclone`. Configurar o remoto: `rclone config` → nome `r2-backup`, tipo *s3*, provedor *Cloudflare*, chave do bucket de backups, endpoint `https://<account-id>.r2.cloudflarestorage.com`.

Testar na mão e agendar:
```bash
./scripts/backup.sh
crontab -e
15 3 * * * cd /opt/financas && ./scripts/backup.sh >> /var/log/financas-backup.log 2>&1
```
Retenção: 7 diários, 4 semanais (domingo), 6 mensais (dia 1º). Falha → email para `BACKUP_ALERT_TO`.

Snapshot da VPS pelo painel da Hostinger: camada extra, nunca a principal.

## 4. Teste de restauração (a cada trimestre)
1. Copie a chave privada para a VPS **só durante o teste**: `scp financas-backup.key vps:/tmp/`.
2. `BACKUP_AGE_IDENTITY=/tmp/financas-backup.key ./scripts/restore.sh daily/<arquivo-mais-recente>.dump.age`
3. Confira os números que o script imprime (usuários, lançamentos, último pagamento) contra o app.
4. `docker compose exec db psql -U financas -d postgres -c 'drop database financas_restore'` e `shred -u /tmp/financas-backup.key`.
5. Anote a data do teste aqui:

| Data | Backup usado | Resultado |
| --- | --- | --- |
| | | |

## 5. Em caso de desastre (VPS perdida)
Nova VPS → passo 2 → restaurar o backup mais recente no banco `financas` (`./scripts/restore.sh <arquivo> financas`) → subir o `app`. Os comprovantes estão no R2 e voltam sozinhos se `ATTACHMENTS_KEY` for a mesma.
