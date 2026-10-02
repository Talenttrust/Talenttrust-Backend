# PowerShell script to create fork and PR for Talenttrust-Backend issues

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Talenttrust-Backend PR Creation Script" -ForegroundColor Cyan
Write-Host "Issues: #1409, #1401, #1335" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check if fork exists
Write-Host "[1/5] Checking if fork exists..." -ForegroundColor Yellow
$forkUrl = "https://github.com/itzsoftwaredevops-sys/Talenttrust-Backend"
$forkCheck = git ls-remote $forkUrl 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Fork not found at: $forkUrl" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please create the fork first:" -ForegroundColor Yellow
    Write-Host "1. Open: https://github.com/Talenttrust/Talenttrust-Backend" -ForegroundColor White
    Write-Host "2. Click 'Fork' button" -ForegroundColor White
    Write-Host "3. Re-run this script" -ForegroundColor White
    Write-Host ""
    Write-Host "Press Enter to open the repository in your browser..." -ForegroundColor Cyan
    Read-Host
    Start-Process "https://github.com/Talenttrust/Talenttrust-Backend"
    exit 1
}

Write-Host "✅ Fork exists!" -ForegroundColor Green
Write-Host ""

# Step 2: Verify fork remote
Write-Host "[2/5] Setting up fork remote..." -ForegroundColor Yellow
$remotes = git remote
if ($remotes -notcontains "fork") {
    git remote add fork $forkUrl
    Write-Host "✅ Fork remote added" -ForegroundColor Green
} else {
    Write-Host "✅ Fork remote already exists" -ForegroundColor Green
}
Write-Host ""

# Step 3: Push branch to fork
Write-Host "[3/5] Pushing branch to fork..." -ForegroundColor Yellow
git push -u fork fix/issues-1409-1401-1335

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to push to fork" -ForegroundColor Red
    Write-Host "Please check your GitHub authentication and try again" -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ Branch pushed successfully!" -ForegroundColor Green
Write-Host ""

# Step 4: Get default branch
Write-Host "[4/5] Detecting default branch..." -ForegroundColor Yellow
$defaultBranch = ((git remote show origin | Select-String "HEAD branch").ToString() -split ':')[1].Trim()
Write-Host "✅ Default branch: $defaultBranch" -ForegroundColor Green
Write-Host ""

# Step 5: Create PR URL
Write-Host "[5/5] Generating PR creation URL..." -ForegroundColor Yellow
$prTitle = "feat: harden auth and audit validation (issues #1409, #1401, #1335)"
$prUrl = "https://github.com/Talenttrust/Talenttrust-Backend/compare/${defaultBranch}...itzsoftwaredevops-sys:Talenttrust-Backend:fix/issues-1409-1401-1335?expand=1"

Write-Host "✅ Ready to create PR!" -ForegroundColor Green
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Next Steps:" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Opening PR creation page in browser..." -ForegroundColor White
Write-Host "2. Copy the PR description from: PR_DESCRIPTION.md" -ForegroundColor White
Write-Host "3. Paste it into the PR description field" -ForegroundColor White
Write-Host "4. Click 'Create pull request'" -ForegroundColor White
Write-Host ""
Write-Host "PR Title:" -ForegroundColor Yellow
Write-Host "  $prTitle" -ForegroundColor White
Write-Host ""
Write-Host "Target Branch: $defaultBranch" -ForegroundColor Yellow
Write-Host ""
Write-Host "Press Enter to open PR creation page..." -ForegroundColor Cyan
Read-Host
Start-Process $prUrl

Write-Host ""
Write-Host "✅ All done! Check your browser to complete the PR creation." -ForegroundColor Green
Write-Host ""
