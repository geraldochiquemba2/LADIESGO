#!/usr/bin/env bash
# LadiesGo — backup diário do Postgres (pg_dump comprimido + retenção 7 dias).
# Uso no VPS:  sudo cp backup-postgres.sh /opt/ladiesgo/ && sudo chmod +x /opt/ladiesgo/backup-postgres.sh
# Cron (sudo crontab -e):  15 3 * * * /opt/ladiesgo/backup-postgres.sh >> /var/log/ladiesgo-backup.log 2>&1
# Restaura teste mensal:  gunzip -c ladiesgo-YYYY-MM-DD.sql.gz | docker compose exec -T postgres psql -U $POSTGRES_USER -d restore_test
set -euo pipefail

# --- config (via .env ao lado do docker-compose.yml, com fallbacks seguros) ---
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$SCRIPT_DIR/.env"; set +a
fi
COMPOSE_DIR="${COMPOSE_DIR:-$SCRIPT_DIR}"
BACKUP_DIR="${BACKUP_DIR:-/opt/ladiesgo/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
POSTGRES_USER="${POSTGRES_USER:-ladiesgo}"
POSTGRES_DB="${POSTGRES_DB:-ladiesgo}"
DATE="$(date +%F)"                       # YYYY-MM-DD
STAMP="$(date +%F_%H%M%S)"
LOCK="/tmp/ladiesgo-backup.lock"
OUT="$BACKUP_DIR/ladiesgo-${DATE}.sql.gz"
TMP="$BACKUP_DIR/.ladiesgo-${STAMP}.sql.gz.tmp"

mkdir -p "$BACKUP_DIR"
exec 9>"$LOCK"
if ! flock -n 9; then echo "[$(date -Is)] backup já em curso, a sair." >&2; exit 0; fi

echo "[$(date -Is)] a iniciar pg_dump $POSTGRES_DB → $OUT"
# -Fp (plain) + gzip -9 = .sql.gz portátil (restore com psql em qualquer versão).
# -T = sem TTY (corre no cron). --no-owner/--no-acl evitam erros de role no restore.
docker compose --project-directory "$COMPOSE_DIR" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fp --no-owner --no-acl \
  | gzip -9 > "$TMP"

# valida gzip + tamanho mínimo (apanhar dumps vazios: <50KB = suspeito)
gzip -t "$TMP"
SIZE=$(stat -c%s "$TMP" 2>/dev/null || stat -f%z "$TMP")
if [ "$SIZE" -lt 51200 ]; then
  echo "[$(date -Is)] ERRO: dump com ${SIZE} bytes (<50KB), a manter .tmp para inspecção." >&2
  exit 1
fi
mv -f "$TMP" "$OUT"
chmod 600 "$OUT"
echo "[$(date -Is)] ok: $OUT ($(du -h "$OUT" | cut -f1))"

# retenção: apaga .sql.gz com mais de N dias (padrão 7 → ~7 ficheiros em disco)
# shellcheck disable=SC2086
find "$BACKUP_DIR" -maxdepth 1 -name 'ladiesgo-*.sql.gz' -type f -mtime +$((RETENTION_DAYS - 1)) -print -delete
echo "[$(date -Is)] retenção ${RETENTION_DAYS}d aplicada; ficheiros actuais:"
ls -lh "$BACKUP_DIR"/ladiesgo-*.sql.gz || true
