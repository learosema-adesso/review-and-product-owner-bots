#!/usr/bin/env bash
# Moves the floating major version tag (v1) to a release tag (v1.2.3), but only if that release is
# the newest one of its major version. Pre-releases and anything that is not a plain vX.Y.Z version
# leave the tags alone. Needs all tags of the repository to be fetched.
#
# Usage: move-major-tag.sh <release tag> [remote, default: origin]
set -euo pipefail

tag="${1:?usage: move-major-tag.sh <release tag> [remote]}"
remote="${2:-origin}"

if [[ ! "$tag" =~ ^v([0-9]+)\.[0-9]+\.[0-9]+$ ]]; then
  echo "$tag is not a plain release version (vX.Y.Z), no major version tag is moved."
  exit 0
fi
major="v${BASH_REMATCH[1]}"

# a fix for an older line (v1.0.1 after v1.1.0) must not pull the major tag backwards
newest="$(git tag --list "${major}.*" | grep -E "^${major}\.[0-9]+\.[0-9]+$" | sort -V | tail -n 1)"
if [[ "$newest" != "$tag" ]]; then
  echo "$tag is not the newest release of $major ($newest is), $major stays where it is."
  exit 0
fi

git tag -f "$major" "${tag}^{commit}"
git push --force "$remote" "refs/tags/${major}"
echo "$major now points to $tag"
