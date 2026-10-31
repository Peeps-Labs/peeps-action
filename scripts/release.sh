#!/usr/bin/env bash
# Releases the checked-out commit when src/version.ts names a version that has
# no tag yet. `.github/workflows/release.yml` runs it on main once CI has passed
# there, so a merged "Release x.y.z" change ships without anyone cutting a tag.
#
# For ACTION_VERSION x.y.z it:
#   1. creates the annotated tag vx.y.z on HEAD, with the README's "## x.y.z"
#      section as its message (no section, no release: the notes are required);
#   2. moves the major tag (vx) to that commit, when vx.y.z is the newest
#      release of its major version;
#   3. publishes the GitHub release vx.y.z with the same notes.
#
# Each step checks first, so a rerun after a partial failure finishes the job,
# and a push to main that does not change the version does nothing.
set -euo pipefail

remote=${RELEASE_REMOTE:-origin}
sha=$(git rev-parse HEAD)

version=$(sed -nE 's/^export const ACTION_VERSION = "([0-9]+\.[0-9]+\.[0-9]+)";$/\1/p' src/version.ts)
if [ -z "$version" ]; then
  echo "::error::src/version.ts has no ACTION_VERSION of the form x.y.z"
  exit 1
fi
tag="v$version"
major="v${version%%.*}"

# The checkout may predate a tag another run pushed.
git fetch --quiet --force --tags "$remote"

newest_of() { git tag -l "$1" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n1 || true; }
commit_of() { git rev-parse -q --verify "refs/tags/$1^{commit}" || true; }

# The README section "## x.y.z", up to the next "## " heading, trimmed.
notes_at() {
  git show "$1:README.md" | awk -v h="## $version" '
    $0 == h { found = 1; next }
    found && /^## / { exit }
    found { lines[++n] = $0 }
    END {
      first = 1; while (first <= n && lines[first] ~ /^[[:space:]]*$/) first++
      last = n;  while (last >= first && lines[last] ~ /^[[:space:]]*$/) last--
      for (i = first; i <= last; i++) print lines[i]
    }'
}

notes_file=$(mktemp)
trap 'rm -f "$notes_file"' EXIT

tag_sha=$(commit_of "$tag")
if [ -n "$tag_sha" ]; then
  echo "$tag already exists at $tag_sha"
  notes_at "$tag_sha" >"$notes_file"
else
  newest=$(newest_of 'v*')
  if [ -n "$newest" ] && [ "$(printf '%s\n%s\n' "$newest" "$tag" | sort -V | tail -n1)" != "$tag" ]; then
    echo "::error::ACTION_VERSION $version is older than the newest release, $newest"
    exit 1
  fi
  notes_at "$sha" >"$notes_file"
  if [ ! -s "$notes_file" ]; then
    echo "::error::README.md has no notes under \"## $version\"; rename its \"## Unreleased\" section to \"## $version\" in the release change"
    exit 1
  fi
  git tag -a "$tag" -m "peeps-action $tag" -m "$(cat "$notes_file")" "$sha"
  if ! git push --quiet "$remote" "refs/tags/$tag"; then
    echo "::error::Could not push $tag. Check that no tag ruleset keeps GitHub Actions from creating v* tags."
    exit 1
  fi
  echo "Tagged $tag at $sha"
  tag_sha=$sha
fi

if [ "$(newest_of "$major.*")" = "$tag" ]; then
  if [ "$(commit_of "$major")" = "$tag_sha" ]; then
    echo "$major already points at $tag"
  else
    git tag -f -a "$major" -m "peeps-action $major: $tag" "$tag_sha" >/dev/null
    if ! git push --quiet --force "$remote" "refs/tags/$major"; then
      echo "::error::Could not move $major. Check that no tag ruleset keeps GitHub Actions from updating v* tags."
      exit 1
    fi
    echo "Moved $major to $tag"
  fi
fi

if gh release view "$tag" >/dev/null 2>&1; then
  echo "Release $tag already exists"
else
  latest=false
  [ "$(newest_of 'v*')" = "$tag" ] && latest=true
  if [ ! -s "$notes_file" ]; then
    echo "::error::README.md at $tag has no notes under \"## $version\" for its release"
    exit 1
  fi
  gh release create "$tag" --verify-tag --title "$tag" --notes-file "$notes_file" --latest="$latest"
  echo "Published release $tag"
fi
