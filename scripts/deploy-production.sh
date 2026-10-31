#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "production deploy: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required"
command -v bun >/dev/null 2>&1 || fail "Bun is required"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "run this command inside the repository"
cd "${repo_root}"

branch="$(git branch --show-current)"
[[ "${branch}" == "main" ]] || fail "current branch is '${branch:-detached HEAD}'; switch to main first"

if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  fail "the working tree is not clean; commit or stash every change first"
fi

git remote get-url origin >/dev/null 2>&1 || fail "the origin remote is missing"

echo "[deploy] Fetching origin/main..."
git fetch --prune origin

head_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse refs/remotes/origin/main)"

git merge-base --is-ancestor "${remote_sha}" "${head_sha}" || \
  fail "local main is behind or diverged from origin/main; update it before deploying"

ahead_count="$(git rev-list --count "${remote_sha}..${head_sha}")"
[[ "${ahead_count}" -gt 0 ]] || fail "main has no new commit to deploy"

echo "[deploy] Running release gates for ${head_sha}..."
docker compose config >/dev/null
bun run check-types
bun run test
bun run build
bash -n \
  scripts/api-smoke.sh \
  scripts/backup-postgres.sh \
  scripts/deploy-production.sh \
  scripts/restore-verify.sh \
  scripts/web-smoke.sh

echo "[deploy] Pushing ${ahead_count} commit(s) to production main..."
git push origin HEAD:refs/heads/main

remote_url="$(git remote get-url origin)"
repository=""
case "${remote_url}" in
  https://github.com/*)
    repository="${remote_url#https://github.com/}"
    ;;
  git@github.com:*)
    repository="${remote_url#git@github.com:}"
    ;;
  ssh://git@github.com/*)
    repository="${remote_url#ssh://git@github.com/}"
    ;;
esac
repository="${repository%.git}"

actions_url=""
if [[ -n "${repository}" ]]; then
  actions_url="https://github.com/${repository}/actions/workflows/deploy.yml"
fi

echo "[deploy] Production workflow triggered for ${head_sha}."

if command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "[deploy] Waiting for GitHub Actions to register the run..."
  run_id=""
  for _ in {1..18}; do
    run_id="$(gh run list \
      --workflow deploy.yml \
      --commit "${head_sha}" \
      --limit 1 \
      --json databaseId \
      --jq '.[0].databaseId // empty')"
    [[ -n "${run_id}" ]] && break
    sleep 5
  done

  if [[ -n "${run_id}" ]]; then
    echo "[deploy] Watching workflow run ${run_id}..."
    gh run watch "${run_id}" --exit-status
  else
    echo "[deploy] Workflow run was not visible within 90 seconds."
    [[ -n "${actions_url}" ]] && echo "[deploy] Track it at ${actions_url}"
  fi
elif [[ -n "${actions_url}" ]]; then
  echo "[deploy] gh is not authenticated; track the release at ${actions_url}"
fi
