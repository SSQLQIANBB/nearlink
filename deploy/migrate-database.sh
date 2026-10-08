#!/usr/bin/env bash
# Run in /opt/todesk after loading the selected backend image, before compose up.
set -euo pipefail
umask 077
compose=(docker compose --env-file .env.production -f docker-compose.prod.yml)
database_name="$("${compose[@]}" run --rm --no-deps -T backend node -p 'process.env.DB_NAME || ""')"
[[ "$database_name" =~ ^[a-zA-Z0-9_]+$ ]] || { echo 'Invalid DB_NAME; refusing migration' >&2; exit 1; }
mysql_containers="$(docker ps -q --filter label=com.docker.compose.service=mysql --filter health=healthy --filter network="${SHARED_SERVICES_NETWORK:-shared-services}")"
[[ -n "$mysql_containers" && "$mysql_containers" != *$'\n'* ]] || { echo 'Expected exactly one healthy MySQL container' >&2; exit 1; }
# SSH 部署账号不一定拥有 /opt/todesk 下管理员创建的备份目录。
backup_root="${DATABASE_BACKUP_DIR:-$HOME/.local/state/nearlink/backups}"
backup_dir="$backup_root/schema-$(date -u +%Y%m%dT%H%M%SZ)-${IMAGE_TAG:-manual}"
mkdir -p "$backup_dir"
docker inspect --format '{{.Config.Image}}' todesk-backend > "$backup_dir/previous-backend-image.txt" 2>/dev/null || true
"${compose[@]}" stop backend
# A failed backup or migration leaves writers stopped and fails the deployment.
docker exec "$mysql_containers" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --routines --triggers --no-tablespaces --set-gtid-purged=OFF "$1"' sh "$database_name" > "$backup_dir/database.sql"
test -s "$backup_dir/database.sql"
sha256sum "$backup_dir/database.sql" > "$backup_dir/database.sql.sha256"
echo "Database backup: $backup_dir"
"${compose[@]}" run --rm --no-deps -T backend pnpm db:migrate
