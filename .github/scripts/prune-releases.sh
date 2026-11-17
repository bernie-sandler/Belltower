#!/usr/bin/env bash
# Delete GitHub releases superseded by <tag>, so at most one release and one pre-release are kept.
# Only releases are deleted: the git tags (and Docker images) stay.
#
# A stable tag removes every older release and pre-release. A pre-release tag removes older pre-releases and
# leaves stable releases alone. Drafts and anything newer than <tag> are never touched, so an older tag's run
# finishing late can't delete a newer release.
#
# Usage: prune-releases.sh <tag>   (needs GH_TOKEN and GITHUB_REPOSITORY)
set -euo pipefail

current="${1:?usage: prune-releases.sh <tag>}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"

# Semver-ish ordering with GNU sort -V; "-" becomes "~" so 1.0.0-rc.1 sorts before 1.0.0.
key() { printf '%s' "${1#v}" | tr '-' '~'; }
older() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$(key "$1")" "$(key "$2")" | sort -V | head -n1)" = "$(key "$1")" ]; }

current_is_pre=false
case "$current" in *-*) current_is_pre=true ;; esac

gh release list --repo "$repo" --limit 1000 \
  --json tagName,isPrerelease,isDraft \
  --jq '.[] | select(.isDraft | not) | "\(.tagName) \(.isPrerelease)"' |
while read -r tag is_pre; do
  older "$tag" "$current" || continue
  if [ "$current_is_pre" = true ] && [ "$is_pre" != true ]; then
    continue
  fi
  echo "Deleting superseded release $tag (tag kept)"
  gh release delete "$tag" --repo "$repo" --yes
done
