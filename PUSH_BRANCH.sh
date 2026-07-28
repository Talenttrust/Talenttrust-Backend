#!/bin/bash
# Push script for enhancement/rate-limit-429-headers branch
# This script pushes the branch to GitHub as Abolax123

set -e

REPO_PATH="/home/gamp/Desktop/wave/Talenttrust-Backend"
BRANCH="enhancement/rate-limit-429-headers"

echo "📋 Rate Limit 429 Headers - Push Script"
echo "======================================="
echo ""
echo "Repository: $REPO_PATH"
echo "Branch: $BRANCH"
echo ""

cd "$REPO_PATH"

# Verify we're on the correct branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    echo "❌ Error: Not on branch $BRANCH (currently on $CURRENT_BRANCH)"
    exit 1
fi

# Verify the commit exists
COMMIT=$(git rev-parse HEAD)
echo "✅ Commit ready: $COMMIT"
echo ""

# Show what will be pushed
echo "📝 Changes to push:"
git log origin/main..HEAD --oneline
echo ""

# Verify remote
REMOTE=$(git remote get-url origin)
echo "🔗 Remote: $REMOTE"
echo ""

# Instructions for pushing
echo "🚀 To push this branch, follow these steps:"
echo ""
echo "1. If using HTTPS with GitHub credentials:"
echo "   git push -u origin $BRANCH"
echo "   (You may be prompted for GitHub credentials)"
echo ""
echo "2. If using SSH (requires SSH key added to GitHub):"
echo "   git remote set-url origin git@github.com:Abolax123/Talenttrust-Backend.git"
echo "   git push -u origin $BRANCH"
echo ""
echo "3. After push, create PR at:"
echo "   https://github.com/Abolax123/Talenttrust-Backend/pull/new/$BRANCH"
echo ""
echo "4. Use the PR description from:"
echo "   $REPO_PATH/PR_DESCRIPTION_RATE_LIMIT_429.md"
echo ""
