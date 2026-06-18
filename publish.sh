#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# publish.sh — Build verification and npm publish for @romatech/orm
# ---------------------------------------------------------------------------
# Usage:
#   ./publish.sh          # bump minor and publish (default)
#   ./publish.sh patch    # bump patch, then publish
#   ./publish.sh minor    # bump minor, then publish
#   ./publish.sh major    # bump major, then publish
# ---------------------------------------------------------------------------

BUMP="${1:-minor}"
PKG_NAME="@romatech/orm"

echo "============================================"
echo " $PKG_NAME — publish pipeline"
echo "============================================"
echo ""

# 1. Ensure we are in the project root
if [ ! -f "package.json" ]; then
    echo "ERROR: package.json not found. Run this script from the project root."
    exit 1
fi

# 2. Ensure npm is logged in
echo "[1/8] Checking npm authentication..."
if [ -n "${NPM_TOKEN:-}" ]; then
    echo "       Using NPM_TOKEN from environment"
    echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc
elif ! npm whoami &>/dev/null; then
    echo "ERROR: Not logged in to npm. Set NPM_TOKEN or run 'npm login' first."
    exit 1
fi
echo "       Authenticated as: $(npm whoami 2>/dev/null || echo 'token-based')"
echo ""

# 3. Install dependencies
echo "[2/8] Installing dependencies..."
npm install --legacy-peer-deps
echo "       Done."
echo ""

# 4. Build
echo "[3/8] Building..."
npm run build
echo ""

# 5. Run tests
echo "[4/8] Running tests..."
npm test
echo ""

# 6. Version bump
echo "[5/8] Bumping version ($BUMP)..."
npm version "$BUMP" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")
echo "       New version: $NEW_VERSION"
echo ""

# 7. Update CHANGELOG
echo "[6/8] Updating CHANGELOG.md..."
if [ -f "CHANGELOG.md" ]; then
    DATE=$(date +%Y-%m-%d)
    sed -i "s/## \[Unreleased\]/## [Unreleased]\n\n## [$NEW_VERSION] - $DATE/" CHANGELOG.md
    echo "       Done."
else
    echo "       (no CHANGELOG.md found, skipping)"
fi
echo ""

# 8. Publish
echo "[7/8] Publishing $PKG_NAME@$NEW_VERSION to npm..."
npm publish --access public
echo ""

echo "============================================"
echo " Published $PKG_NAME@$NEW_VERSION"
echo "============================================"

# 9. Commit and tag
echo ""
echo "[8/8] Committing version bump and creating git tag..."
git add package.json package-lock.json CHANGELOG.md 2>/dev/null || true
git commit -m "chore: release v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
echo ""
echo "Don't forget to push:"
echo "  git push && git push --tags"
