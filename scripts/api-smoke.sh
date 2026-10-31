#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE_URL:-http://localhost:3000}"

curl --fail --silent --show-error "$BASE/livez" | grep -q '"status":"live"'
readiness="$(curl --fail --silent --show-error "$BASE/readyz")"
printf '%s' "$readiness" | grep -q '"status":"ready"'

version="$(curl --fail --silent --show-error "$BASE/version")"
if [[ -n "${EXPECTED_SHA:-}" ]]; then
  actual_sha="$(printf '%s' "$version" | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')"
  test "$actual_sha" = "$EXPECTED_SHA"
fi

curl --fail --silent --show-error --get "$BASE/trpc/healthCheck" | grep -q 'OK'

for procedure in config.operations.overview config.operations.history config.appStore.overview config.appClient.overview config.appClient.history appFeedback.list; do
  settings="$(curl --silent --show-error --get "$BASE/trpc/$procedure")"
  printf '%s' "$settings" | grep -q '"code":"UNAUTHORIZED"'
done

# The iOS app's settings are public and cacheable; malformed feedback is refused before anything is saved.
app_config="$(curl --fail --silent --show-error --include "$BASE/api/app/config")"
printf '%s' "$app_config" | grep -qi '^cache-control: public, max-age=300'
printf '%s' "$app_config" | grep -q '"review":{"enabled":'
printf '%s' "$app_config" | grep -q '"feedback":{"enabled":'
invalid_feedback="$(curl --silent --show-error --write-out '\n%{http_code}' -X POST -H 'content-type: application/json' --data '{"installationId":"not-a-uuid","category":"bug","message":"smoke"}' "$BASE/api/app/feedback")"
printf '%s' "$invalid_feedback" | tail -n 1 | grep -qx '400'
printf '%s' "$invalid_feedback" | grep -q '"field":"installationId"'
invalid_upload="$(curl --silent --show-error --write-out '\n%{http_code}' -X POST -H 'content-type: application/json' --data '{"installationId":"not-a-uuid","byteLength":10}' "$BASE/api/app/feedback/uploads")"
printf '%s' "$invalid_upload" | tail -n 1 | grep -qx '400'
printf '%s' "$readiness" | grep -q '"feedbackStorage":{"configured":'

providers="$(curl --fail --silent --show-error "$BASE/api/auth/providers")"
printf '%s' "$providers" | grep -q '"providers":\['

billing_catalog="$(curl --fail --silent --show-error "$BASE/api/billing/catalog")"
printf '%s' "$billing_catalog" | grep -q '"configured":'
case "${EXPECT_BILLING_CONFIGURED:-}" in
  "") ;;
  1 | true)
    if ! printf '%s' "$billing_catalog" | grep -q '"configured":true'; then
      echo "API smoke: billing is not configured in the target environment" >&2
      exit 1
    fi
    ;;
  0 | false)
    if ! printf '%s' "$billing_catalog" | grep -q '"configured":false'; then
      echo "API smoke: billing is unexpectedly configured in the target environment" >&2
      exit 1
    fi
    ;;
  *) echo "EXPECT_BILLING_CONFIGURED must be 1, 0, true, or false" >&2; exit 1 ;;
esac
case "${EXPECT_BILLING_LIVE:-}" in
  "") ;;
  1 | true)
    if ! printf '%s' "$readiness" | grep -q '"livemode":true'; then
      echo "API smoke: production billing is not using Stripe Live mode" >&2
      exit 1
    fi
    ;;
  0 | false)
    if ! printf '%s' "$readiness" | grep -Eq '"livemode":false|"livemode":null'; then
      echo "API smoke: billing unexpectedly reports Stripe Live mode" >&2
      exit 1
    fi
    ;;
  *) echo "EXPECT_BILLING_LIVE must be 1, 0, true, or false" >&2; exit 1 ;;
esac
case "${EXPECT_ANALYTICS_CONFIGURED:-}" in
  "") ;;
  1 | true)
    if ! printf '%s' "$readiness" | grep -q '"analytics":{"configured":true'; then
      echo "API smoke: PostHog server analytics is not configured" >&2
      exit 1
    fi
    expected_server_analytics_host="${EXPECT_SERVER_ANALYTICS_HOST:-}"
    expected_server_analytics_host="${expected_server_analytics_host%/}"
    if [[ -n "${expected_server_analytics_host}" ]] &&
      ! printf '%s' "$readiness" | grep -Fq '"host":"'"${expected_server_analytics_host}"'"'; then
      echo "API smoke: PostHog server host does not match the expected ingestion host" >&2
      exit 1
    fi
    if [[ -n "${EXPECT_ANALYTICS_PROJECT_TOKEN:-}" ]]; then
      if command -v sha256sum >/dev/null 2>&1; then
        expected_analytics_fingerprint="$(printf '%s' "$EXPECT_ANALYTICS_PROJECT_TOKEN" | sha256sum | cut -c1-12)"
      else
        expected_analytics_fingerprint="$(printf '%s' "$EXPECT_ANALYTICS_PROJECT_TOKEN" | shasum -a 256 | cut -c1-12)"
      fi
      if ! printf '%s' "$readiness" | grep -Fq '"tokenFingerprint":"'"${expected_analytics_fingerprint}"'"'; then
        echo "API smoke: PostHog server token does not match the expected project token" >&2
        exit 1
      fi
    fi
    ;;
  0 | false)
    if ! printf '%s' "$readiness" | grep -q '"analytics":{"configured":false'; then
      echo "API smoke: PostHog server analytics is unexpectedly configured" >&2
      exit 1
    fi
    ;;
  *) echo "EXPECT_ANALYTICS_CONFIGURED must be 1, 0, true, or false" >&2; exit 1 ;;
esac
if printf '%s' "$billing_catalog" | grep -Eq 'stripeCustomerId|stripeSubscriptionId|price_|sk_|rk_|whsec_'; then
  echo "Billing catalog exposed a Stripe identifier" >&2
  exit 1
fi

billing_status_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$BASE/api/billing/status")"
test "$billing_status_code" = "401"

# Product procedures (packages/product/smoke/api.sh) run with BASE and readiness available.
product_smoke="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/packages/product/smoke/api.sh"
if [[ -f "${product_smoke}" ]]; then
  # shellcheck source=/dev/null
  source "${product_smoke}"
fi

echo "API smoke checks passed for ${EXPECTED_SHA:-local build}."
