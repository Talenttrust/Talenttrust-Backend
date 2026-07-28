#!/bin/bash

# GitHub Push Script for Abolax123 Account
# This script will prompt for your GitHub credentials and push the branch

echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║         GitHub Authentication - Abolax123 Account               ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo ""

REPO_PATH="/home/gamp/Desktop/wave/Talenttrust-Backend"
BRANCH="enhancement/rate-limit-429-headers"

cd "$REPO_PATH" || exit 1

# Verify current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    echo "❌ Error: Not on branch $BRANCH (currently on $CURRENT_BRANCH)"
    exit 1
fi

echo "📋 Repository: $REPO_PATH"
echo "🌳 Branch: $BRANCH"
echo ""

# Show commit info
echo "📝 Commit Details:"
git log -1 --oneline
echo ""

echo "🔐 GitHub Authentication Options:"
echo ""
echo "Option 1: Use GitHub Personal Access Token (RECOMMENDED)"
echo "   - Go to: https://github.com/settings/tokens"
echo "   - Create new token with 'repo' scope"
echo "   - Username: Abolax123"
echo "   - Password: <paste your token>"
echo ""
echo "Option 2: Use GitHub Username & Password"
echo "   - Username: Abolax123"
echo "   - Password: <your GitHub password>"
echo ""

# Configure git user for this push
echo "ℹ️  Configuring Git user as Abolax123..."
git config user.name "Abolax123"
git config user.email "abolax123@github.com"
git config --local credential.username "Abolax123"

echo "✅ Git user configured as Abolax123"
echo ""

# Ensure HTTPS is being used
git remote set-url origin https://github.com/Abolax123/Talenttrust-Backend.git

echo "🔗 Remote URL: $(git remote get-url origin)"
echo ""

# Attempt push
echo "🚀 Pushing branch to GitHub..."
echo "   (Git will prompt for your GitHub credentials below)"
echo ""

git push -u origin "$BRANCH"

if [ $? -eq 0 ]; then
    echo ""
    echo "╔════════════════════════════════════════════════════════════════════╗"
    echo "║                    ✅ PUSH SUCCESSFUL!                           ║"
    echo "╚════════════════════════════════════════════════════════════════════╝"
    echo ""
    echo "📌 Next Steps:"
    echo ""
    echo "1. Create Pull Request:"
    echo "   https://github.com/Abolax123/Talenttrust-Backend/pull/new/$BRANCH"
    echo ""
    echo "2. PR Title:"
    echo "   feat(rate-limit): return 429 with Retry-After headers and safe-error contract"
    echo ""
    echo "3. PR Description:"
    echo "   Open: PR_DESCRIPTION_RATE_LIMIT_429.md"
    echo "   Copy content to GitHub PR description field"
    echo ""
    echo "4. Labels:"
    echo "   enhancement, security, documentation"
    echo ""
else
    echo ""
    echo "❌ Push failed. Please check:"
    echo "   1. Your GitHub credentials are correct"
    echo "   2. Abolax123 account has access to the repository"
    echo "   3. You're using a Personal Access Token (not password)"
    echo ""
    exit 1
fi
