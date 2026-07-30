#!/usr/bin/env bash
# Cut a patch release: bump app/package.json, commit, tag, push.
#
# We do the git steps explicitly because `npm version`'s automatic
# commit/tag silently no-ops when run from a git subdirectory (app/),
# which used to leave every weekly release without a tag.
set -euo pipefail

cd "$(dirname "$0")/.." # app/

# Safety: refuse on a dirty tree or off main.
if [[ -n $(git status --porcelain) ]]; then
  echo "error: working tree not clean; aborting" >&2
  exit 1
fi
if [[ $(git rev-parse --abbrev-ref HEAD) != main ]]; then
  echo "error: not on main; aborting" >&2
  exit 1
fi

# Bump the version file only; prints the new version as "vX.Y.Z".
tag=$(npm version patch --no-git-tag-version)

git add package.json
git commit -m "Release ${tag}"
# Lightweight tag, matching all previous release tags. Push it
# explicitly: --follow-tags only pushes annotated tags.
git tag "${tag}"
git push origin main "${tag}"

echo "released ${tag} — CI will build and publish the GitHub Release"
