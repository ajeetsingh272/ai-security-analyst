#!/usr/bin/env bash
# Configures required status checks on the default branch. P0-02 AC5.
#
#   bash scripts/setup-branch-protection.sh [--dry-run]
#
# This is a manual provisioning command, not part of any gate. It is in the repo
# rather than in somebody's shell history because "required checks are configured"
# is an acceptance criterion, and a criterion met by a click nobody recorded is a
# criterion that silently stops being true after a settings change.
#
# KNOWN BLOCKER: branch protection and rulesets both require GitHub Pro, Team or
# Enterprise on a PRIVATE repository. On the Free plan this script exits 2 with the
# API's own message. That is the same plan limitation that blocks GitHub Pages for
# the progress dashboard — see docs/ci.md and docs/progress-dashboard.md. The
# configuration below is the applied-on-upgrade state, verbatim, so nothing has to
# be reconstructed later.
#
# Exit codes: 0 applied · 2 blocked by plan (expected today) · 1 anything else.
set -uo pipefail
cd "$(dirname "$0")/.."

: "${REPO:=ajeetsingh272/ai-security-analyst}"
: "${BRANCH:=main}"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# The job names that must pass before a merge. These are check-RUN names, which is
# a job's `name:` when set and its id otherwise — scripts/validate-workflows.mjs
# asserts they are unique across workflows, because duplicates cannot be selected
# individually here.
#
# The filter jobs (`changes · …`) are deliberately NOT required. They exist to
# decide whether real work runs, and requiring them adds no signal.
#
# A job skipped by `if:` reports as skipped, which GitHub counts as satisfied. That
# is what makes path filtering compatible with required checks, and why none of the
# CI workflows filter at the trigger — a workflow skipped by `on.paths` reports
# nothing at all, and a required check that never reports blocks the PR forever.
CONTEXTS=(
  "typescript"
  "clean-clone"
  "go"
  "detections"
  "integration"
  "planning"
)

# Reviewer requirements are deliberately left off. AC5 asks for required status
# checks, and a solo maintainer cannot approve their own pull request — turning on
# mandatory reviews here would lock the only committer out of their own repository.
# The two-reviewer rule for `trust-guarantee` tickets (SECURITY.md) is enforced by
# CODEOWNERS and review convention, which is P0-09 territory.
payload() {
  local ctx_json
  ctx_json=$(printf '"%s",' "${CONTEXTS[@]}")
  ctx_json="[${ctx_json%,}]"
  cat <<JSON
{
  "required_status_checks": { "strict": true, "contexts": $ctx_json },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
}

echo "repo   : $REPO"
echo "branch : $BRANCH"
echo "checks : ${CONTEXTS[*]}"
echo

if [ "$DRY" = 1 ]; then
  echo "── dry run · payload ──"
  payload
  exit 0
fi

# "strict": true means a branch must be up to date with main before merging. Worth
# the rebases: it is what stops two independently-green pull requests from merging
# into a combination neither one tested.
tmp=$(mktemp)
payload > "$tmp"

out=$(gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" \
        -H "Accept: application/vnd.github+json" \
        --input "$tmp" 2>&1)
rc=$?
rm -f "$tmp"

if [ $rc -eq 0 ]; then
  echo "✓ branch protection applied to $BRANCH"
  echo "  required checks:"
  printf '    - %s\n' "${CONTEXTS[@]}"
  echo
  echo "Verify in the UI, and confirm each name matches a real check run. A required"
  echo "check whose name does not exist blocks every pull request permanently."
  exit 0
fi

if printf '%s' "$out" | grep -qi 'Upgrade to GitHub Pro\|only available.*public\|403'; then
  echo "BLOCKED · branch protection is unavailable on this plan." >&2
  echo >&2
  printf '%s\n' "$out" | sed 's/^/  /' >&2
  echo >&2
  echo "  Branch protection and rulesets require GitHub Pro, Team or Enterprise on a" >&2
  echo "  private repository. Two ways forward, both outside this script:" >&2
  echo "    1. make the repository public — also unblocks the Pages dashboard; or" >&2
  echo "    2. upgrade the account to Pro." >&2
  echo >&2
  echo "  Re-run this script afterwards. Nothing else needs to change: the workflows" >&2
  echo "  already report check names that match the list above." >&2
  exit 2
fi

echo "FAILED · unexpected error applying branch protection" >&2
printf '%s\n' "$out" | sed 's/^/  /' >&2
exit 1
