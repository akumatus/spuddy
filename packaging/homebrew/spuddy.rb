# Homebrew Cask for Spuddy.
#
# This is the source-of-truth copy. At release time, update-cask.sh fills in
# `version` + `sha256` from the published dmg, then this file is copied to the
# public tap repo (akumatus/homebrew-spuddy) as Casks/spuddy.rb and pushed.
# See README.md in this folder for the full flow.
#
# NOTE: the app is ad-hoc signed but not notarized, so Homebrew still
# quarantines it by default — users open it once via right-click > Open, or
# install with `brew install --cask --no-quarantine spuddy` to skip that.
cask "spuddy" do
  version "0.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/akumatus/spuddy/releases/download/v#{version}/Spuddy-#{version}-arm64.dmg",
      verified: "github.com/akumatus/spuddy/"
  name "Spuddy"
  desc "Hand-crocheted potato desktop pet with daily encouragement cards"
  homepage "https://github.com/akumatus/spuddy"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: ">= :big_sur"

  app "Spuddy.app"

  zap trash: [
    "~/.config/spuddy",
    "~/Library/Application Support/Spuddy",
    "~/Library/Preferences/com.spuddy.app.plist",
    "~/Library/Saved Application State/com.spuddy.app.savedState",
  ]
end
