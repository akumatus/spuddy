# Homebrew Cask distribution

Lets people install Spuddy with `brew install --cask spuddy` and upgrade with
`brew upgrade`. This folder holds the cask source; the actual tap is a separate
public repo you stand up at launch.

## Prerequisites (why this can't go live yet)

- **The repo must be public.** Homebrew downloads the dmg from the GitHub
  Release with no auth, so `akumatus/spuddy` (and its releases) must be public.
  While the repo is private the cask will 404.
- **Gatekeeper still applies.** The dmg is ad-hoc signed but not notarized, and
  Homebrew quarantines casks by default — so first launch still needs a
  right-click > Open (or `brew install --cask --no-quarantine spuddy`). Homebrew
  does not remove that step for unsigned apps. Add Developer ID signing +
  notarization later for a clean double-click experience.

## One-time setup at launch

1. Make `akumatus/spuddy` public and cut at least one release (`cd app && npm version patch`).
2. Create the tap repo — it must be named `homebrew-<tap>`:

   ```bash
   gh repo create akumatus/homebrew-spuddy --public --clone
   mkdir -p homebrew-spuddy/Casks
   ```

3. Fill in the cask from the latest release and copy it into the tap:

   ```bash
   packaging/homebrew/update-cask.sh 0.1.1        # downloads the dmg, sets version + sha256
   cp packaging/homebrew/spuddy.rb homebrew-spuddy/Casks/spuddy.rb
   (cd homebrew-spuddy && git add Casks/spuddy.rb && git commit -m "spuddy 0.1.1" && git push)
   ```

Users then install with:

```bash
brew install --cask akumatus/spuddy/spuddy
# or: brew tap akumatus/spuddy && brew install --cask spuddy
```

## Every release after that

```bash
cd app && npm version patch                        # builds + publishes the release
packaging/homebrew/update-cask.sh 0.1.2            # refresh version + sha256
cp packaging/homebrew/spuddy.rb ../homebrew-spuddy/Casks/spuddy.rb
(cd ../homebrew-spuddy && git commit -am "spuddy 0.1.2" && git push)
```

This can be automated later with a GitHub Action in the release workflow that
pushes to the tap using a PAT (`HOMEBREW_TAP_TOKEN`) — worth doing once releases
are frequent.
