#!/usr/bin/env bash
# Fill in version + sha256 in spuddy.rb from a published release dmg.
# Run this after a release is up (the repo/release must be public so the dmg
# is downloadable), then copy spuddy.rb into the tap repo and push.
#
# Usage: ./update-cask.sh <version>       e.g. ./update-cask.sh 0.1.1
set -euo pipefail

ver="${1:?usage: update-cask.sh <version>  (e.g. 0.1.1)}"
url="https://github.com/akumatus/spuddy/releases/download/v${ver}/Spuddy-${ver}-arm64.dmg"
cask="$(cd "$(dirname "$0")" && pwd)/spuddy.rb"

tmp="$(mktemp -t spuddy-dmg-XXXX)"
trap 'rm -f "$tmp"' EXIT

echo "→ downloading $url"
curl -fSL "$url" -o "$tmp"
sha="$(shasum -a 256 "$tmp" | awk '{print $1}')"

sed -i '' -E "s/^  version \".*\"/  version \"${ver}\"/" "$cask"
sed -i '' -E "s/^  sha256 \".*\"/  sha256 \"${sha}\"/" "$cask"

echo "✓ ${cask}"
echo "  version ${ver}"
echo "  sha256  ${sha}"
echo
echo "Next: copy this file to the tap repo and push:"
echo "  cp \"$cask\" ../homebrew-spuddy/Casks/spuddy.rb"
echo "  (cd ../homebrew-spuddy && git add Casks/spuddy.rb && git commit -m \"spuddy ${ver}\" && git push)"
