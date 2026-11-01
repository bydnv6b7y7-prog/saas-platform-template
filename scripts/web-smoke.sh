#!/usr/bin/env bash
set -euo pipefail

WEB_BASE_URL="${WEB_BASE_URL:-http://127.0.0.1:3001}"
EXPECTED_SHA="${EXPECTED_SHA:-}"
EXPECT_INDEXING="${EXPECT_INDEXING:-0}"
# full: the target has real data (releases); basic: an empty CI database. Product checks decide what this means.
SMOKE_LEVEL="${SMOKE_LEVEL:-full}"
EXPECT_ANALYTICS_CONFIGURED="${EXPECT_ANALYTICS_CONFIGURED:-}"
EXPECT_BROWSER_ANALYTICS_HOST="${EXPECT_BROWSER_ANALYTICS_HOST:-}"
EXPECT_SERVER_ANALYTICS_HOST="${EXPECT_SERVER_ANALYTICS_HOST:-}"
EXPECTED_BRAND_NAME="${EXPECTED_BRAND_NAME:-${VITE_BRAND_NAME:-Northwind}}"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/web-smoke.XXXXXX")"
trap 'rm -rf "${tmp_dir}"' EXIT

curl_request() {
  if [[ "${WEB_BASE_URL}" == http://127.0.0.1:* || "${WEB_BASE_URL}" == http://localhost:* ]]; then
    command curl --noproxy "*" "$@"
    return
  fi
  command curl "$@"
}

curl_ok=(--fail --silent --show-error --max-time 30)

version_json="$(curl_request "${curl_ok[@]}" "${WEB_BASE_URL}/version.json")"
observed_sha="$(printf '%s' "${version_json}" | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if [[ -z "${observed_sha}" ]]; then
  echo "web smoke: /version.json did not return {\"sha\": string}"
  exit 1
fi
if [[ -n "${EXPECTED_SHA}" && "${observed_sha}" != "${EXPECTED_SHA}" ]]; then
  echo "web smoke: expected SHA ${EXPECTED_SHA}, got ${observed_sha}"
  exit 1
fi

fetch_page() {
  local path="$1"
  local name="$2"
  curl_request "${curl_ok[@]}" \
    -D "${tmp_dir}/${name}.headers" \
    -o "${tmp_dir}/${name}.html" \
    "${WEB_BASE_URL}${path}"
}

fetch_page "/privacy" "privacy-1"
fetch_page "/privacy" "privacy-2"

grep -q '<h1[^>]*>Privacy</h1>' "${tmp_dir}/privacy-1.html"
if ! grep -Fq "<title>Privacy Policy | ${EXPECTED_BRAND_NAME}</title>" "${tmp_dir}/privacy-1.html"; then
  echo "web smoke: privacy title does not use brand ${EXPECTED_BRAND_NAME}"
  exit 1
fi
for header in \
  'content-security-policy:' \
  'x-content-type-options: nosniff' \
  'x-frame-options: DENY' \
  'referrer-policy:' \
  'permissions-policy:'; do
  if ! grep -qi "^${header}" "${tmp_dir}/privacy-1.headers"; then
    echo "web smoke: missing security header ${header}"
    exit 1
  fi
done

csp_header="$(tr -d '\r' < "${tmp_dir}/privacy-1.headers" | grep -i '^content-security-policy:' | sed -n '1p')"
connect_src="$(printf '%s' "${csp_header}" | tr ';' '\n' | sed -n 's/^[[:space:]]*connect-src[[:space:]]*/ /p' | sed -n '1p')"
browser_analytics_origin="${EXPECT_BROWSER_ANALYTICS_HOST%/}"
server_analytics_origin="${EXPECT_SERVER_ANALYTICS_HOST%/}"

csp_connects_to() {
  case " ${connect_src} " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

case "${EXPECT_ANALYTICS_CONFIGURED}" in
  "") ;;
  1 | true)
    if [[ -z "${browser_analytics_origin}" ]]; then
      echo "web smoke: expected browser analytics host is missing"
      exit 1
    fi
    if ! csp_connects_to "${browser_analytics_origin}"; then
      echo "web smoke: CSP connect-src does not allow the expected browser analytics proxy"
      exit 1
    fi
    if [[ -n "${server_analytics_origin}" ]] && csp_connects_to "${server_analytics_origin}"; then
      echo "web smoke: CSP connect-src exposes the server-only PostHog ingestion origin"
      exit 1
    fi
    ;;
  0 | false)
    if [[ -n "${browser_analytics_origin}" ]] && csp_connects_to "${browser_analytics_origin}"; then
      echo "web smoke: CSP connect-src allows analytics even though analytics is disabled"
      exit 1
    fi
    if [[ -n "${server_analytics_origin}" ]] && csp_connects_to "${server_analytics_origin}"; then
      echo "web smoke: CSP connect-src exposes server analytics even though browser analytics is disabled"
      exit 1
    fi
    ;;
  *)
    echo "EXPECT_ANALYTICS_CONFIGURED must be 1, 0, true, or false"
    exit 1
    ;;
esac

nonce_from_headers() {
  tr -d '\r' < "$1" | sed -n "s/^Content-Security-Policy:.*'nonce-\([^']*\)'.*/\1/ip" | sed -n '1p'
}

nonce_1="$(nonce_from_headers "${tmp_dir}/privacy-1.headers")"
nonce_2="$(nonce_from_headers "${tmp_dir}/privacy-2.headers")"
if [[ -z "${nonce_1}" || -z "${nonce_2}" || "${nonce_1}" == "${nonce_2}" ]]; then
  echo "web smoke: CSP nonce is missing or reused across requests"
  exit 1
fi

BODY_PATH="${tmp_dir}/privacy-1.html" EXPECTED_NONCE="${nonce_1}" bun -e '
  const html = await Bun.file(Bun.env.BODY_PATH).text();
  const nonce = Bun.env.EXPECTED_NONCE;
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map(([tag]) => tag);
  const valid = scripts.length > 0 && scripts.every((tag) =>
    tag.includes(`nonce="${nonce}"`) ||
      tag.includes("nonce=" + String.fromCharCode(39) + nonce + String.fromCharCode(39))
  );
  if (!valid) {
    console.error("web smoke: an HTML script is missing the response CSP nonce");
    process.exit(1);
  }

  const canonicalTags = [...html.matchAll(/<link\b[^>]*\brel=["\x27]canonical["\x27][^>]*>/gi)];
  if (canonicalTags.length !== 1) {
    console.error(`web smoke: expected one canonical link, got ${canonicalTags.length}`);
    process.exit(1);
  }
  const href = canonicalTags[0][0].match(/\bhref=["\x27]([^"\x27]+)["\x27]/i)?.[1];
  if (!href || new URL(href).pathname !== "/privacy") {
    console.error(`web smoke: invalid privacy canonical ${href ?? "missing"}`);
    process.exit(1);
  }

  for (const marker of [
    `name="description"`,
    `property="og:title"`,
    `property="og:url"`,
    `name="twitter:card"`,
  ]) {
    if (!html.includes(marker)) {
      console.error(`web smoke: missing SEO marker ${marker}`);
      process.exit(1);
    }
  }
'

curl_request "${curl_ok[@]}" -D "${tmp_dir}/robots.headers" -o "${tmp_dir}/robots.txt" "${WEB_BASE_URL}/robots.txt"
curl_request "${curl_ok[@]}" -D "${tmp_dir}/sitemap.headers" -o "${tmp_dir}/sitemap.xml" "${WEB_BASE_URL}/sitemap.xml"
grep -qi '^content-type: text/plain; charset=utf-8' "${tmp_dir}/robots.headers"
grep -qi '^content-type: application/xml; charset=utf-8' "${tmp_dir}/sitemap.headers"

if [[ "${EXPECT_INDEXING}" == "1" || "${EXPECT_INDEXING}" == "true" ]]; then
  grep -q '^Allow: /$' "${tmp_dir}/robots.txt"
  grep -q '^Sitemap: https\?://' "${tmp_dir}/robots.txt"
  grep -q '<loc>[^<]*/privacy</loc>' "${tmp_dir}/sitemap.xml"
  if grep -q '<loc>[^<]*/\(login\|account/\|admin/\)' "${tmp_dir}/sitemap.xml"; then
    echo "web smoke: sitemap contains a private URL"
    exit 1
  fi
  grep -q 'name="robots" content="index, follow' "${tmp_dir}/privacy-1.html"
else
  grep -q '^Disallow: /$' "${tmp_dir}/robots.txt"
  if grep -q '<url>' "${tmp_dir}/sitemap.xml"; then
    echo "web smoke: disabled indexing emitted sitemap URLs"
    exit 1
  fi
  grep -q 'name="robots" content="noindex, nofollow, noarchive"' "${tmp_dir}/privacy-1.html"
fi

asset_path="$(grep -aoE '/assets/[A-Za-z0-9._-]+\.(css|js)' "${tmp_dir}/privacy-1.html" | sed -n '1p')"
if [[ -z "${asset_path}" ]]; then
  echo "web smoke: no hashed asset found in SSR HTML"
  exit 1
fi
curl_request "${curl_ok[@]}" -D "${tmp_dir}/asset.headers" -o /dev/null "${WEB_BASE_URL}${asset_path}"
if ! grep -qi '^cache-control: public, max-age=31536000, immutable' "${tmp_dir}/asset.headers"; then
  echo "web smoke: hashed asset is missing immutable one-year caching"
  exit 1
fi

curl_request --fail --silent --show-error --max-time 30 \
  -H 'Accept-Encoding: br, gzip' \
  -D "${tmp_dir}/asset-compressed.headers" \
  -o /dev/null \
  "${WEB_BASE_URL}${asset_path}"
if ! grep -Eqi '^content-encoding: (br|gzip)' "${tmp_dir}/asset-compressed.headers"; then
  echo "web smoke: hashed asset was not served pre-compressed"
  exit 1
fi

not_found_status="$(curl_request --silent --show-error --max-time 30 -o "${tmp_dir}/not-found.html" -w '%{http_code}' "${WEB_BASE_URL}/__web_smoke_not_found__")"
if [[ "${not_found_status}" != "404" ]]; then
  echo "web smoke: unknown route returned ${not_found_status}, expected 404"
  exit 1
fi
grep -q 'This page isn' "${tmp_dir}/not-found.html"

fetch_page "/login" "login"
if ! grep -q 'lucide-loader-circle' "${tmp_dir}/login.html"; then
  echo "web smoke: /login was not emitted as a client-only route shell"
  exit 1
fi
grep -q 'name="robots" content="noindex, nofollow, noarchive"' "${tmp_dir}/login.html"

assert_permanent_redirect() {
  local path="$1"
  local name="$2"
  local target="$3"
  local status
  status="$(curl_request --silent --show-error --max-time 30 \
    -D "${tmp_dir}/${name}.headers" \
    -o /dev/null \
    -w '%{http_code}' \
    "${WEB_BASE_URL}${path}")"
  if [[ "${status}" != "308" ]]; then
    echo "web smoke: ${path} returned ${status}, expected 308"
    exit 1
  fi
  if ! grep -Eqi "^location: (https?://[^/]+)?${target}([?#[:space:]]|$)" "${tmp_dir}/${name}.headers"; then
    echo "web smoke: ${path} did not redirect to ${target}"
    exit 1
  fi
}

assert_private_client_shell() {
  local route_path="$1"
  local name="$2"
  local status
  status="$(curl_request --silent --show-error --max-time 30 \
    -D "${tmp_dir}/${name}.headers" \
    -o "${tmp_dir}/${name}.html" \
    -w '%{http_code}' \
    "${WEB_BASE_URL}${route_path}")"
  if [[ "${status}" != "200" ]]; then
    echo "web smoke: private client route ${route_path} returned ${status}, expected 200"
    exit 1
  fi
  if ! grep -q 'name="robots" content="noindex, nofollow, noarchive"' "${tmp_dir}/${name}.html"; then
    echo "web smoke: private client route ${route_path} is missing noindex protection"
    exit 1
  fi
}

# Protected account routes intentionally hydrate before Better Auth resolves the
# browser session. Their SSR boundary is a noindex shell; auth and feature
# redirects run in the client router without rendering private account data.
assert_private_client_shell "/account/billing" "private-billing"

# Product pages, redirects and budgets (packages/product/smoke/web.sh) run with the helpers above.
product_smoke="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/packages/product/smoke/web.sh"
if [[ -f "${product_smoke}" ]]; then
  # shellcheck source=/dev/null
  source "${product_smoke}"
fi

echo "web smoke: ok (sha=${observed_sha}, SEO, nonce-per-request, public SSR, branded 404, cache, compression, product checks)"
