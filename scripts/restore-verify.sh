#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
: "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE is required}"
: "${RESTORE_VERIFY_HOST:?RESTORE_VERIFY_HOST is required}"
: "${RESTORE_VERIFY_USER:?RESTORE_VERIFY_USER is required}"
: "${RESTORE_VERIFY_PASSWORD:?RESTORE_VERIFY_PASSWORD is required}"

if [[ "${RESTORE_VERIFY_ACKNOWLEDGE:-}" != "create-and-drop-isolated-database" ]]; then
  echo "Set RESTORE_VERIFY_ACKNOWLEDGE=create-and-drop-isolated-database" >&2
  exit 1
fi

BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-market-intelligence/postgres}"
RESTORE_VERIFY_PORT="${RESTORE_VERIFY_PORT:-5432}"
if [[ ! "$BACKUP_S3_BUCKET" =~ ^[a-zA-Z0-9._-]+$ ]] || [[ "$BACKUP_S3_PREFIX" == *".."* ]] || [[ "$BACKUP_S3_PREFIX" == /* ]]; then
  echo "Invalid backup bucket or prefix" >&2
  exit 1
fi

aws_args=()
if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
  aws_args+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
fi

temp_root="${TMPDIR:-/tmp}"
work_dir="$(mktemp -d "${temp_root%/}/market-restore.XXXXXX")"
verify_db="restore_verify_$(date -u +%Y%m%d%H%M%S)_${RANDOM}"
if [[ ! "$verify_db" =~ ^restore_verify_[0-9]+_[0-9]+$ ]]; then
  echo "Unsafe verification database name" >&2
  exit 1
fi

export PGPASSWORD="$RESTORE_VERIFY_PASSWORD"
created=0
cleanup() {
  if [[ "$created" == "1" ]]; then
    dropdb --if-exists --force --host="$RESTORE_VERIFY_HOST" --port="$RESTORE_VERIFY_PORT" --username="$RESTORE_VERIFY_USER" "$verify_db" >/dev/null 2>&1 || true
  fi
  if [[ -n "${work_dir:-}" && "$work_dir" == "${temp_root%/}/market-restore."* && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
}
trap cleanup EXIT

latest_key="$(aws "${aws_args[@]}" s3api list-objects-v2 \
  --bucket "$BACKUP_S3_BUCKET" \
  --prefix "$BACKUP_S3_PREFIX/daily/" \
  --output json \
  | jq -r '.Contents // [] | map(.Key) | map(select(endswith(".dump.age"))) | sort | last // empty')"
if [[ -z "$latest_key" || "$latest_key" != "$BACKUP_S3_PREFIX/daily/"*.dump.age ]]; then
  echo "No valid daily backup found" >&2
  exit 1
fi

encrypted_file="$work_dir/backup.dump.age"
plain_file="$work_dir/backup.dump"
manifest_file="$work_dir/backup.dump.age.sha256"
aws "${aws_args[@]}" s3 cp "s3://$BACKUP_S3_BUCKET/$latest_key" "$encrypted_file" --only-show-errors
aws "${aws_args[@]}" s3 cp "s3://$BACKUP_S3_BUCKET/${latest_key}.sha256" "$manifest_file" --only-show-errors
expected_hash="$(awk 'NR == 1 { print $1 }' "$manifest_file")"
actual_hash="$(sha256sum "$encrypted_file" | awk '{ print $1 }')"
if [[ ! "$expected_hash" =~ ^[a-f0-9]{64}$ ]] || [[ "$expected_hash" != "$actual_hash" ]]; then
  echo "Backup checksum validation failed" >&2
  exit 1
fi
age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$plain_file" "$encrypted_file"

createdb --host="$RESTORE_VERIFY_HOST" --port="$RESTORE_VERIFY_PORT" --username="$RESTORE_VERIFY_USER" "$verify_db"
created=1
pg_restore --exit-on-error --no-owner --no-acl --host="$RESTORE_VERIFY_HOST" --port="$RESTORE_VERIFY_PORT" --username="$RESTORE_VERIFY_USER" --dbname="$verify_db" "$plain_file"

readiness="$(psql --host="$RESTORE_VERIFY_HOST" --port="$RESTORE_VERIFY_PORT" --username="$RESTORE_VERIFY_USER" --dbname="$verify_db" --tuples-only --no-align --command="SELECT (to_regclass('public.app_store_entries') IS NOT NULL AND to_regclass('public.market_changes') IS NOT NULL AND to_regclass('public.finding_analysis_versions') IS NOT NULL)::text")"
if [[ "$readiness" != "true" ]]; then
  echo "Restored schema failed readiness validation" >&2
  exit 1
fi

entry_count="$(psql --host="$RESTORE_VERIFY_HOST" --port="$RESTORE_VERIFY_PORT" --username="$RESTORE_VERIFY_USER" --dbname="$verify_db" --tuples-only --no-align --command="SELECT count(*) FROM app_store_entries")"
verified_at="$(date -u +%FT%TZ)"
report="$work_dir/restore-verification.json"
jq -n --arg verifiedAt "$verified_at" --arg backupKey "$latest_key" --arg entries "$entry_count" '{verifiedAt:$verifiedAt,backupKey:$backupKey,appStoreEntries:($entries|tonumber),status:"passed"}' > "$report"
aws "${aws_args[@]}" s3 cp "$report" "s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/restore-verifications/$(date -u +%Y-%m).json" --only-show-errors

printf '{"event":"postgres_restore_verification_passed","backupKey":"%s","entries":%s}\n' "$latest_key" "$entry_count"
