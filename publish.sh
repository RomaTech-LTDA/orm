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
echo "[1/6] Checking npm authentication..."
if ! npm whoami &>/dev/null; then
    echo "ERROR: Not logged in to npm. Run 'npm login' first."
    exit 1
fi
echo "       Logged in as: $(npm whoami)"
echo ""

# 3. Install dependencies
echo "[2/6] Installing dependencies..."
npm ci --silent
echo "       Done."
echo ""

# 4. Build
echo "[3/6] Building..."
npm run build
echo ""

# 5. Version bump
echo "[4/6] Bumping version ($BUMP)..."
npm version "$BUMP" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")
echo "       New version: $NEW_VERSION"
echo ""

# 6. Dry run to verify package contents
echo "[5/6] Verifying package contents (dry run)..."
npm pack --dry-run
echo ""

# 7. Publish
echo "[6/6] Publishing $PKG_NAME@$NEW_VERSION to npm..."
npm publish --access public
echo ""

echo "============================================"
echo " Published $PKG_NAME@$NEW_VERSION"
echo "============================================"

# 8. Commit and tag
echo ""
echo "Committing version bump and creating git tag..."
git add package.json package-lock.json 2>/dev/null || true
git commit -m "chore: release v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
echo ""
echo "Don't forget to push:"
echo "  git push && git push --tags"
