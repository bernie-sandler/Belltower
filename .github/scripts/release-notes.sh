#!/usr/bin/env bash
# Print the release notes for a version: its section from CHANGELOG.md, followed by the "Full Changelog" compare
# link from the link references at the bottom of the file (when there is one).
# A section starts at "## [X.Y.Z]..." (Keep a Changelog), "## X.Y.Z" or "## X.Y.Z: Title", and ends at the next
# "## " heading or the link references. Pass "Unreleased" for the "## [Unreleased]" section.
# Exits 1 if the changelog has no section (or an empty one) for that version.
#
# Usage: release-notes.sh <version> [changelog-path]
set -euo pipefail

version="${1:?usage: release-notes.sh <version> [changelog-path]}"
changelog="${2:-CHANGELOG.md}"

# Everything after the version's heading up to the next "## " heading or the link references, with leading and
# trailing blank lines removed.
section="$(awk -v v="$version" '
  function is_head(line) {
    return index(line, "## [" v "]") == 1 || line == "## " v || index(line, "## " v ":") == 1 \
      || index(line, "## " v " ") == 1
  }
  !found && is_head($0) { found = 1; next }
  found && (/^## / || /^\[[^]]+\]: /) { exit }
  found { lines[++n] = $0 }
  END {
    first = 1; while (first <= n && lines[first] ~ /^[[:space:]]*$/) first++
    last = n;  while (last >= first && lines[last] ~ /^[[:space:]]*$/) last--
    for (i = first; i <= last; i++) print lines[i]
  }
' "$changelog")"

if [ -z "$section" ]; then
  echo "No release notes for $version in $changelog (expected a \"## [$version]\" or \"## $version\" section)" >&2
  exit 1
fi

link="$(awk -v ref="[$version]: " 'index($0, ref) == 1 { print substr($0, length(ref) + 1); exit }' "$changelog")"

printf '%s\n' "$section"
if [ -n "$link" ]; then
  printf '\n**Full Changelog**: %s\n' "$link"
fi
