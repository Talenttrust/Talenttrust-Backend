# Fork and PR Creation Instructions for Talenttrust-Backend

## Step 1: Create Fork (if not already exists)

1. Navigate to: https://github.com/Talenttrust/Talenttrust-Backend
2. Click the "Fork" button in the top-right corner
3. Select your account (`itzsoftwaredevops-sys`) as the destination
4. Wait for the fork to be created

## Step 2: Verify Fork Exists

Once forked, the repository will be available at:
```
https://github.com/itzsoftwaredevops-sys/Talenttrust-Backend
```

## Step 3: Push Branch to Fork

Run these commands in PowerShell:

```powershell
cd C:\Users\HP\Stellar-GreenPay\Talenttrust-Backend

# Verify fork remote is set (already done)
git remote -v

# Push to fork
git push -u fork fix/issues-1409-1401-1335
```

## Step 4: Create Pull Request

### Option A: Via GitHub Web Interface

1. Navigate to: https://github.com/itzsoftwaredevops-sys/Talenttrust-Backend
2. You should see a banner saying "fix/issues-1409-1401-1335 had recent pushes"
3. Click "Compare & pull request"
4. Ensure the base repository is `Talenttrust/Talenttrust-Backend` and base branch is the **default branch**
5. Copy the PR description from `PR_DESCRIPTION.md` (in this directory)
6. Click "Create pull request"

### Option B: Via GitHub CLI (if available)

```powershell
# Check default branch first
$defaultBranch = (git remote show origin | Select-String "HEAD branch").ToString().Split(':')[-1].Trim()

# Create PR
gh pr create --repo Talenttrust/Talenttrust-Backend --base $defaultBranch --head itzsoftwaredevops-sys:fix/issues-1409-1401-1335 --title "feat: harden auth and audit validation (issues #1409, #1401, #1335)" --body-file PR_DESCRIPTION.md
```

## Step 5: Verify CI/CD

After creating the PR:
1. Check that all GitHub Actions workflows pass
2. Review any automated checks or tests
3. Address any issues if workflows fail

## What Was Done

✅ Created feature branch: `fix/issues-1409-1401-1335`
✅ Implemented issue #1409: Concurrent execution hardening in authCache.ts
✅ Implemented issue #1401: Validation boundaries in apiKeys.ts
✅ Implemented issue #1335: Compatibility contracts in inputValidation.ts
✅ Committed all changes with descriptive commit message
✅ Prepared comprehensive PR description

## Files Modified

1. `src/auth/authCache.ts` - Added concurrency control and timing metrics
2. `src/auth/apiKeys.ts` - Added validation boundaries and error handling
3. `src/audit/inputValidation.ts` - Added compatibility contract documentation

## Next Steps

After the PR is created and reviewed:
1. Address any code review feedback
2. Ensure all CI checks pass
3. Wait for maintainer approval and merge

---

**Note**: The branch `fix/issues-1409-1401-1335` is ready and committed. You just need to complete the fork and push steps above.
