# Product checks, sourced by scripts/web-smoke.sh after the platform checks.
# Available: WEB_BASE_URL, EXPECT_INDEXING, SMOKE_LEVEL (full | basic), EXPECTED_BRAND_NAME, tmp_dir, curl_request, curl_ok,
# fetch_page, assert_permanent_redirect and assert_private_client_shell.

fetch_page "/" "home"
if ! grep -q '<h1' "${tmp_dir}/home.html"; then
  echo "web smoke: the home page did not render a heading"
  exit 1
fi
if [[ "${EXPECT_INDEXING}" == "1" || "${EXPECT_INDEXING}" == "true" ]]; then
  grep -q '<loc>[^<]*/privacy</loc>' "${tmp_dir}/sitemap.xml"
fi
