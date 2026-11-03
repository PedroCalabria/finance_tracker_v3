#!/usr/bin/env bash
# Restaura um backup (etapa 8). Use para o teste trimestral e em caso de perda.
#   ./scripts/restore.sh daily/financas-2026-11-03T031500Z.dump.age [banco-destino]
#
# Por padrão restaura num banco NOVO ("financas_restore") para conferir sem
# tocar no de produção. A chave privada do age vem de BACKUP_AGE_IDENTITY
# (arquivo), que deve ficar fora da VPS e só ser trazido para o teste.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

OBJ="${1:?informe o caminho do backup no bucket, ex.: daily/financas-....dump.age}"
TARGET="${2:-financas_restore}"
REMOTE="${BACKUP_RCLONE_REMOTE:-r2-backup:financas-backups}"
: "${BACKUP_AGE_IDENTITY:?defina BACKUP_AGE_IDENTITY (arquivo da chave privada do age)}"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
rclone copyto "$REMOTE/$OBJ" "$TMP/backup.age"
age -d -i "$BACKUP_AGE_IDENTITY" -o "$TMP/backup.dump" "$TMP/backup.age"

docker compose exec -T db psql -U financas -d postgres -c "drop database if exists \"$TARGET\";" -c "create database \"$TARGET\";"
docker compose exec -T db pg_restore -U financas -d "$TARGET" --no-owner < "$TMP/backup.dump"

echo "Restaurado em \"$TARGET\". Conferência rápida:"
docker compose exec -T db psql -U financas -d "$TARGET" -c "select (select count(*) from users) usuarios, (select count(*) from items where deleted_at is null) lancamentos, (select max(paid_at) from payments) ultimo_pagamento;"
