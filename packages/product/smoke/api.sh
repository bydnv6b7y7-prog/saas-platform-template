# Product checks, sourced by scripts/api-smoke.sh after the platform checks.
# Available: BASE, readiness.

curl --fail --silent --show-error --get "$BASE/trpc/example.hello" --data-urlencode 'input={}' | grep -q 'Hello, world!'
for procedure in example.whoami notes.list notes.attachments.usage; do
  response="$(curl --silent --show-error --get "$BASE/trpc/${procedure}")"
  printf '%s' "$response" | grep -q '"code":"UNAUTHORIZED"'
done
