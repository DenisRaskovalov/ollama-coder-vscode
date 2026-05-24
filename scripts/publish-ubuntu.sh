#!/usr/bin/env bash
# Build, validate, package, and (optionally) publish the Ollama Free Coder VS Code
# extension to the Visual Studio Marketplace from an Ubuntu host.
#
# Pipeline:
#   1. Sanity checks  : Node >=18, npm, git clean tree, on the expected branch.
#   2. Build & test   : npm install -> npm run typecheck -> npm test.
#   3. Version bump   : optional, via 'vsce publish patch|minor|major' OR --bump.
#   4. Package .vsix  : npx @vscode/vsce package -o ollama-free-coder-<version>.vsix.
#   5. Verify package : lists files, fails if PUBLISHING.md / src/ / test/ leak.
#   6. Publish        : if VSCE_PAT is set OR --publish flag passed, runs
#                       'vsce publish'; otherwise just emits the next command.
#   7. Open VSX mirror: optional, when OVSX_TOKEN is set OR --ovsx is passed.
#   8. Tag release    : 'git tag v<version> && git push origin v<version>'.
#
# Usage:
#   ./scripts/publish-ubuntu.sh                # dry run: build, test, package
#   VSCE_PAT=xxx ./scripts/publish-ubuntu.sh   # publish to Marketplace
#   ./scripts/publish-ubuntu.sh --publish      # same, when PAT is in keychain
#   ./scripts/publish-ubuntu.sh --bump patch   # 0.1.0 -> 0.1.1 before packaging
#   ./scripts/publish-ubuntu.sh --bump minor --publish
#   OVSX_TOKEN=xxx ./scripts/publish-ubuntu.sh --publish --ovsx
#   ./scripts/publish-ubuntu.sh --allow-dirty  # don't require a clean tree
#   ./scripts/publish-ubuntu.sh --branch main  # require this branch (default: main)
#
# Exit codes:
#    0 success
#   10 prerequisite missing
#   20 git tree dirty / wrong branch
#   30 build or test failed
#   40 package / publish failed
#
# Honest disclaimer: only YOU can publish. The Marketplace requires a personal
# Azure DevOps Personal Access Token tied to your Microsoft account. This
# script automates everything around 'vsce publish', but the PAT must be
# yours. See PUBLISHING.md for how to mint one.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ----------------------------------------------------------------------------
# CLI parsing
# ----------------------------------------------------------------------------
BUMP=""
DO_PUBLISH=0
DO_OVSX=0
ALLOW_DIRTY=0
REQUIRE_BRANCH="${BRANCH:-main}"

while [ $# -gt 0 ]; do
  case "$1" in
    --bump)         BUMP="$2"; shift 2;;
    --bump=*)       BUMP="${1#--bump=}"; shift;;
    --publish)      DO_PUBLISH=1; shift;;
    --ovsx)         DO_OVSX=1; shift;;
    --allow-dirty)  ALLOW_DIRTY=1; shift;;
    --branch)       REQUIRE_BRANCH="$2"; shift 2;;
    --branch=*)     REQUIRE_BRANCH="${1#--branch=}"; shift;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      printf "unknown arg: %s\n" "$1" >&2
      exit 64
      ;;
  esac
done

# Treat VSCE_PAT being non-empty as an implicit --publish.
if [ -n "${VSCE_PAT:-}" ]; then DO_PUBLISH=1; fi
if [ -n "${OVSX_TOKEN:-}" ]; then DO_OVSX=1; fi

# ----------------------------------------------------------------------------
# Pretty logging
# ----------------------------------------------------------------------------
log()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!! \033[0m %s\n" "$*" >&2; }
die()  { code="${2:-1}"; printf "\033[1;31mxx \033[0m %s\n" "$1" >&2; exit "$code"; }

# ----------------------------------------------------------------------------
# 1. Sanity checks
# ----------------------------------------------------------------------------
log "Step 1/8: sanity checks"

if ! command -v node >/dev/null 2>&1; then
  die "node not found. Run scripts/install-ubuntu.sh first or apt install nodejs." 10
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js $NODE_MAJOR detected; vsce + this script need >=18." 10
fi
command -v npm >/dev/null 2>&1 || die "npm not found." 10
command -v git >/dev/null 2>&1 || die "git not found." 10

# Confirm we're inside this repo.
if [ ! -f "$ROOT_DIR/package.json" ]; then
  die "package.json not found in $ROOT_DIR" 10
fi

PUBLISHER="$(node -p "require('./package.json').publisher")"
NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"

if [ "$PUBLISHER" = "local" ]; then
  die "package.json publisher is still 'local'. Set your real publisher id (see PUBLISHING.md)." 10
fi
log "package: $PUBLISHER.$NAME @ $VERSION"

# Git checks. Done BEFORE npm install so we capture the truly clean tree;
# 'npm install' can touch package-lock.json on its own, which would otherwise
# make every second run of this script fail at the dirty-tree check.
if [ "$ALLOW_DIRTY" != "1" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    git status --short
    die "Git tree is dirty. Commit, stash, or rerun with --allow-dirty." 20
  fi
fi
CUR_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CUR_BRANCH" != "$REQUIRE_BRANCH" ] && [ "$ALLOW_DIRTY" != "1" ]; then
  die "Currently on '$CUR_BRANCH', expected '$REQUIRE_BRANCH'. Use --branch X to override." 20
fi

# ----------------------------------------------------------------------------
# 2. Build & test
# ----------------------------------------------------------------------------
log "Step 2/8: install deps, typecheck, test"

# Snapshot package-lock.json so we can restore it after 'npm install' —
# which often re-writes the lockfile with new timestamps/integrity hashes
# even when no dependency changed. Without this guard, the SECOND run of
# publish-ubuntu.sh would always fail at the dirty-tree check.
_LOCKFILE_HASH_BEFORE=""
if [ -f package-lock.json ] && [ "$ALLOW_DIRTY" != "1" ]; then
  _LOCKFILE_HASH_BEFORE="$(shasum package-lock.json 2>/dev/null | awk '{print $1}')"
fi

# vsce ships in @vscode/vsce — install via npx --yes the first time, but pin
# locally too so re-runs are fast and offline-friendly.
npm install --no-audit --no-fund

# If the lockfile was touched but no dependency actually changed (the
# common case on a re-run), revert it so the next run still sees a
# clean tree. If something legitimately changed, the user can spot the
# diff in 'git status' and decide whether to commit it.
if [ -n "$_LOCKFILE_HASH_BEFORE" ]; then
  _LOCKFILE_HASH_AFTER="$(shasum package-lock.json 2>/dev/null | awk '{print $1}')"
  if [ "$_LOCKFILE_HASH_BEFORE" != "$_LOCKFILE_HASH_AFTER" ]; then
    # Did the actual dependency set change? If 'git diff' on the lockfile
    # shows only metadata churn (the most common case), revert silently.
    # We use --quiet to test; reverting is safe because the previous
    # committed lockfile is by definition consistent with package.json.
    if git diff --quiet package-lock.json; then
      :  # no diff at all; nothing to do
    else
      log "npm install re-wrote package-lock.json; reverting metadata churn"
      git checkout -- package-lock.json
    fi
  fi
fi

# Use 'npm test' which is now: compile + node:test runner
npm test || die "npm test failed" 30

# ----------------------------------------------------------------------------
# 3. Version bump (optional)
# ----------------------------------------------------------------------------
if [ -n "$BUMP" ]; then
  log "Step 3/8: version bump ($BUMP)"
  case "$BUMP" in
    patch|minor|major) ;;
    *) die "--bump must be patch|minor|major (got '$BUMP')" 64 ;;
  esac
  # npm version commits and tags by default; we'll re-tag at the end ourselves.
  npm version "$BUMP" --no-git-tag-version >/dev/null
  VERSION="$(node -p "require('./package.json').version")"
  log "bumped to $VERSION"
  git add package.json package-lock.json 2>/dev/null || true
  git commit -m "Release v$VERSION" >/dev/null
else
  log "Step 3/8: version bump skipped (no --bump)"
fi

# ----------------------------------------------------------------------------
# 4. Package .vsix
#
# Idempotent: re-running on the same version replaces the previous .vsix in
# place. No accidental 'one .vsix per re-run' clutter accumulates.
# ----------------------------------------------------------------------------
log "Step 4/8: package"
VSIX="ollama-free-coder-$VERSION.vsix"
rm -f ./*.vsix
npx --yes @vscode/vsce package -o "$VSIX" || die "vsce package failed" 40
log "produced $VSIX ($(stat -c '%s' "$VSIX" 2>/dev/null || stat -f '%z' "$VSIX") bytes)"

# ----------------------------------------------------------------------------
# 5. Verify package contents
# ----------------------------------------------------------------------------
log "Step 5/8: verify contents"
LISTING="$(mktemp)"
trap 'rm -f "$LISTING"' EXIT
npx --yes @vscode/vsce ls > "$LISTING" || die "vsce ls failed" 40

# Loud failures on leaked dev files.
LEAKS=""
while IFS= read -r line; do
  case "$line" in
    src/*|test/*|PUBLISHING.md|*.ts|package-lock.json|.git/*|node_modules/*)
      LEAKS="$LEAKS\n  $line"
      ;;
  esac
done < "$LISTING"
if [ -n "$LEAKS" ]; then
  printf "Files that should NOT ship are inside the .vsix:%b\n" "$LEAKS" >&2
  die "Tighten .vscodeignore and re-run." 40
fi

# Must-haves
for needed in package.json README.md CHANGELOG.md LICENSE media/icon.png out/extension.js; do
  if ! grep -Fxq "$needed" "$LISTING"; then
    die ".vsix is missing required file: $needed" 40
  fi
done
log "package contents look correct ($(wc -l < "$LISTING") files)"

# ----------------------------------------------------------------------------
# 6. Publish to Marketplace
#
# Idempotent: if the same version was already published, surface that
# clearly instead of dying with the raw 'extension version exists' error.
# Re-running this script is a normal recovery action when step 7 or 8
# fails after a successful publish.
# ----------------------------------------------------------------------------
if [ "$DO_PUBLISH" = "1" ]; then
  log "Step 6/8: publish to Visual Studio Marketplace"
  if [ -z "${VSCE_PAT:-}" ]; then
    die "--publish requested but VSCE_PAT is not set. See PUBLISHING.md to mint a token." 10
  fi

  # Probe the Marketplace first to see if this exact version already exists.
  # The public Gallery API doesn't need auth.
  _ALREADY_PUBLISHED=0
  if command -v curl >/dev/null 2>&1; then
    _GALLERY_BODY="$(curl -fsS \
      -H 'Accept: application/json;api-version=3.0-preview.1' \
      -H 'Content-Type: application/json' \
      -X POST \
      --data "{\"filters\":[{\"criteria\":[{\"filterType\":7,\"value\":\"$PUBLISHER.$NAME\"}]}],\"flags\":914}" \
      'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery' 2>/dev/null || true)"
    if printf '%s' "$_GALLERY_BODY" | grep -Fq "\"version\":\"$VERSION\""; then
      _ALREADY_PUBLISHED=1
    fi
  fi

  if [ "$_ALREADY_PUBLISHED" = "1" ]; then
    warn "$PUBLISHER.$NAME@$VERSION is already on the Marketplace; skipping vsce publish."
    warn "  bump the version first:  ./scripts/publish-ubuntu.sh --bump patch --publish"
  else
    # Tolerate the 'extension version exists' error if our probe missed it
    # (e.g. timing, or a different region of the Gallery). Anything else is
    # fatal as before.
    _PUBLISH_LOG="$(mktemp)"
    if npx --yes @vscode/vsce publish --packagePath "$VSIX" 2>&1 | tee "$_PUBLISH_LOG"; then
      log "published $PUBLISHER.$NAME@$VERSION"
    else
      if grep -Fq 'already exists' "$_PUBLISH_LOG" \
         || grep -Fq 'cannot publish the same version' "$_PUBLISH_LOG"; then
        warn "Marketplace says $VERSION is already published; treating as success."
      else
        rm -f "$_PUBLISH_LOG"
        die "vsce publish failed" 40
      fi
    fi
    rm -f "$_PUBLISH_LOG"
  fi
else
  log "Step 6/8: publish skipped (no --publish / VSCE_PAT)"
fi

# ----------------------------------------------------------------------------
# 7. Open VSX mirror (optional)
# ----------------------------------------------------------------------------
if [ "$DO_OVSX" = "1" ]; then
  log "Step 7/8: mirror to Open VSX (VSCodium / Cursor / Theia users)"
  if [ -z "${OVSX_TOKEN:-}" ]; then
    die "--ovsx requested but OVSX_TOKEN is not set. Get one at https://open-vsx.org/user-settings/tokens" 10
  fi
  # Same idempotency story as the Marketplace step: tolerate 'already exists'.
  _OVSX_LOG="$(mktemp)"
  if npx --yes ovsx publish "$VSIX" -p "$OVSX_TOKEN" 2>&1 | tee "$_OVSX_LOG"; then
    log "mirrored to Open VSX"
  else
    if grep -Fq 'already exists' "$_OVSX_LOG" \
       || grep -Fq 'already published' "$_OVSX_LOG"; then
      warn "Open VSX says $VERSION is already mirrored; treating as success."
    else
      rm -f "$_OVSX_LOG"
      die "ovsx publish failed" 40
    fi
  fi
  rm -f "$_OVSX_LOG"
else
  log "Step 7/8: Open VSX mirror skipped (no --ovsx / OVSX_TOKEN)"
fi

# ----------------------------------------------------------------------------
# 8. Tag the release
# ----------------------------------------------------------------------------
if [ "$DO_PUBLISH" = "1" ]; then
  log "Step 8/8: tag v$VERSION"
  if git rev-parse "v$VERSION" >/dev/null 2>&1; then
    warn "tag v$VERSION already exists locally; skipping local tag creation"
  else
    git tag "v$VERSION" -m "Release v$VERSION"
  fi
  # Push the tag whether we created it now or it already existed locally.
  # 'git push' on an already-pushed tag is a no-op, not an error.
  if git remote get-url origin >/dev/null 2>&1; then
    git push origin "v$VERSION" 2>/dev/null || \
      warn "could not push tag v$VERSION (push manually)"
  fi
else
  log "Step 8/8: tag skipped (publish was a dry run)"
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
echo
log "Done."
cat <<EOF

Artifact:
  $ROOT_DIR/$VSIX

EOF

if [ "$DO_PUBLISH" = "1" ]; then
cat <<EOF
Marketplace page (allow a minute or two for indexing):
  https://marketplace.visualstudio.com/items?itemName=$PUBLISHER.$NAME

Anyone can now install with:
  code --install-extension $PUBLISHER.$NAME

EOF
else
cat <<EOF
To publish:
  1. Mint a PAT (see PUBLISHING.md), then:
       export VSCE_PAT='<your-token>'
       ./scripts/publish-ubuntu.sh --publish

  2. Or test-install the .vsix locally first:
       code --install-extension ./$VSIX --force

EOF
fi
