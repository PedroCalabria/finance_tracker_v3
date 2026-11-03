#!/usr/bin/env bash
# Backup diário do banco (etapa 8, ADR-0008). Roda no host da VPS, pelo cron:
#   15 3 * * * cd /opt/financas && ./scripts/backup.sh >> /var/log/financas-backup.log 2>&1
#
# 1. pg_dump do container "db" em formato custom (comprimido)
# 2. cifra com age (chave pública em BACKUP_AGE_RECIPIENT; a privada fica fora da VPS)
# 3. envia para o bucket de backups no R2 via rclone (remoto "r2-backup")
# 4. retenção: 7 diários, 4 semanais (domingo), 6 mensais (dia 1º)
# 5. em falha, manda email de alerta pelo Resend
#
# Pré-requisitos no host: docker, age, rclone configurado (`rclone config`, tipo s3/Cloudflare,
# com uma chave que só grava no bucket), e as variáveis abaixo no .env do projeto.
set -Eeuo pipefail

cd "$(dirname "$0")/.."
set -a; source .env; set +a

: "${BACKUP_AGE_RECIPIENT:?defina BACKUP_AGE_RECIPIENT (chave pública do age) no .env}"
REMOTE="${BACKUP_RCLONE_REMOTE:-r2-backup:financas-backups}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

alert() {
  local msg="$1"
  echo "[$(date -u +%FT%TZ)] FALHA: $msg" >&2
  if [[ -n "${RESEND_API_KEY:-}" && -n "${BACKUP_ALERT_TO:-}" ]]; then
    curl -sS https://api.resend.com/emails \
      -H "Authorization: Bearer ${RESEND_API_KEY}" -H 'Content-Type: application/json' \
      -d "{\"from\":\"${EMAIL_FROM}\",\"to\":[\"${BACKUP_ALERT_TO}\"],\"subject\":\"Falha no backup do Finanças da Família\",\"text\":\"${msg//\"/\'} em ${STAMP}. Veja /var/log/financas-backup.log na VPS.\"}" >/dev/null || true
  fi
}
trap 'alert "backup interrompido na linha $LINENO"' ERR

FILE="$TMP/financas-$STAMP.dump.age"
docker compose exec -T db pg_dump -U financas -d financas -Fc | age -r "$BACKUP_AGE_RECIPIENT" -o "$FILE"
SIZE=$(stat -c %s "$FILE")
if (( SIZE < 1024 )); then alert "arquivo de backup pequeno demais ($SIZE bytes)"; exit 1; fi

rclone copyto "$FILE" "$REMOTE/daily/$(basename "$FILE")"
[[ "$(date -u +%u)" == "7" ]] && rclone copyto "$FILE" "$REMOTE/weekly/$(basename "$FILE")"
[[ "$(date -u +%d)" == "01" ]] && rclone copyto "$FILE" "$REMOTE/monthly/$(basename "$FILE")"

# Retenção por idade (com folga de 1 dia).
rclone delete --min-age 8d "$REMOTE/daily"
rclone delete --min-age 29d "$REMOTE/weekly"
rclone delete --min-age 185d "$REMOTE/monthly"

echo "[$(date -u +%FT%TZ)] ok: $(basename "$FILE") ($SIZE bytes)"
