#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"

BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-market-intelligence/postgres}"
BACKUP_DAILY_KEEP="${BACKUP_DAILY_KEEP:-14}"
BACKUP_WEEKLY_KEEP="${BACKUP_WEEKLY_KEEP:-8}"

if [[ ! "$BACKUP_S3_BUCKET" =~ ^[a-zA-Z0-9._-]+$ ]] || [[ "$BACKUP_S3_PREFIX" == *".."* ]] || [[ "$BACKUP_S3_PREFIX" == /* ]]; then
  echo "Invalid backup bucket or prefix" >&2
  exit 1
fi
if [[ ! "$BACKUP_DAILY_KEEP" =~ ^[1-9][0-9]*$ ]] || [[ ! "$BACKUP_WEEKLY_KEEP" =~ ^[1-9][0-9]*$ ]]; then
  echo "Retention values must be positive integers" >&2
  exit 1
fi

aws_args=()
if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
  aws_args+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
fi

temp_root="${TMPDIR:-/tmp}"
work_dir="$(mktemp -d "${temp_root%/}/market-backup.XXXXXX")"
cleanup() {
  if [[ -n "${work_dir:-}" && "$work_dir" == "${temp_root%/}/market-backup."* && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
}
trap cleanup EXIT

backup_date="$(date -u +%F)"
week_key="$(date -u +%G-W%V)"
plain_file="$work_dir/postgres.dump"
encrypted_file="$work_dir/postgres-${backup_date}.dump.age"
manifest_file="$encrypted_file.sha256"

pg_dump --dbname="$DATABASE_URL" --format=custom --compress=6 --no-owner --no-acl --file="$plain_file"
age --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted_file" "$plain_file"
rm -f -- "$plain_file"
(
  cd "$work_dir"
  sha256sum "$(basename "$encrypted_file")" > "$(basename "$manifest_file")"
)

daily_key="$BACKUP_S3_PREFIX/daily/${backup_date}.dump.age"
aws "${aws_args[@]}" s3 cp "$encrypted_file" "s3://$BACKUP_S3_BUCKET/$daily_key" --only-show-errors
aws "${aws_args[@]}" s3 cp "$manifest_file" "s3://$BACKUP_S3_BUCKET/${daily_key}.sha256" --only-show-errors

if [[ "$(date -u +%u)" == "7" ]]; then
  weekly_key="$BACKUP_S3_PREFIX/weekly/${week_key}.dump.age"
  aws "${aws_args[@]}" s3 cp "$encrypted_file" "s3://$BACKUP_S3_BUCKET/$weekly_key" --only-show-errors
  aws "${aws_args[@]}" s3 cp "$manifest_file" "s3://$BACKUP_S3_BUCKET/${weekly_key}.sha256" --only-show-errors
fi

prune_prefix() {
  local tier="$1"
  local keep="$2"
  local prefix="$BACKUP_S3_PREFIX/$tier/"
  local keys_file="$work_dir/${tier}-keys"
  aws "${aws_args[@]}" s3api list-objects-v2 \
    --bucket "$BACKUP_S3_BUCKET" \
    --prefix "$prefix" \
    --output json \
    | jq -r '.Contents // [] | map(.Key) | map(select(endswith(".dump.age"))) | sort | reverse | .[]' > "$keys_file"

  tail -n "+$((keep + 1))" "$keys_file" | while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    if [[ "$key" != "$prefix"*.dump.age ]]; then
      echo "Refusing to delete unexpected object key" >&2
      exit 1
    fi
    aws "${aws_args[@]}" s3api delete-object --bucket "$BACKUP_S3_BUCKET" --key "$key" >/dev/null
    aws "${aws_args[@]}" s3api delete-object --bucket "$BACKUP_S3_BUCKET" --key "${key}.sha256" >/dev/null
  done
}

prune_prefix daily "$BACKUP_DAILY_KEEP"
prune_prefix weekly "$BACKUP_WEEKLY_KEEP"

printf '{"event":"postgres_backup_complete","date":"%s","dailyKey":"%s"}\n' "$backup_date" "$daily_key"
