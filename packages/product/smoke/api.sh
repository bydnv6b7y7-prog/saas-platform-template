# Product checks, sourced by scripts/api-smoke.sh after the platform checks.
# Available: BASE, readiness.

curl --fail --silent --show-error --get "$BASE/trpc/example.hello" --data-urlencode 'input={}' | grep -q 'Hello, world!'
whoami="$(curl --silent --show-error --get "$BASE/trpc/example.whoami")"
printf '%s' "$whoami" | grep -q '"code":"UNAUTHORIZED"'
